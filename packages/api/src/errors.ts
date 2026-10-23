import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env.ts";
import { newCode, shown } from "@brianjenkins94/util/auth/codes";
import { shortHash } from "@brianjenkins94/util/hash";
import { redactString } from "@brianjenkins94/util/redact";

/**
 * Errors (README.md, O4): every uncaught error gets an id the person can quote (`E-ABCD-EFGH`, in the
 * 500 they see), and is recorded: grouped by fingerprint (its source, name and top stack frames by function name, so a
 * release's new line numbers don't split a group; util/hash), each occurrence with its route, release, trace id and,
 * signed in, its sign-in and user. Messages and stacks are redacted first (util/redact, and email addresses). A new
 * group emails the owner (at most one such email an hour), as does a group reaching SURGE occurrences in an hour.
 */

/** Occurrences of one group in an hour that email the owner, once, as they're reached. */
export const SURGE = 50;

const EMAIL = /[^\s@<>"',;]+@[^\s@<>"',;]+\.[A-Za-z]{2,}/gu;

/** A message or stack, safe to keep: secrets (util/redact) and email addresses masked, at most `max` characters. */
export const scrub = (text: string, max: number): string => redactString(text).replaceAll(EMAIL, "«email»").slice(0, max);

/** An error's id, as shown to the person: `E-` and a code of util/auth/codes' (40 bits). */
export const newErrorId = (): string => `E-${shown(newCode())}`;

/** The top of a stack, by function name only (line and column change with every bundle). */
const frames = (stack: string | undefined): string[] => (stack ?? "").split("\n").slice(1).map((line) => /^\s*at (?:async )?([^\s(]+)/u.exec(line)?.[1]).filter((name): name is string => name !== undefined).slice(0, 5);

/** What groups occurrences: the source, the name, the top frames (or, without any, the route). */
export const fingerprintOf = async (source: string, name: string, stack: string | undefined, route: string): Promise<string> => shortHash(`${source}|${name}|${frames(stack).join("|") || route}`, 16);

export interface Occurrence {
	"source": "api" | "editor";
	"name": string;
	"message": string;
	"stack"?: string;
	"route": string;
	"release": string;
	"traceId"?: string | null;
	"grantId"?: string | null;
	"userId"?: string | null;
	/** Signed out: the IP, as the audit log's daily keyed hash; nothing else of who. */
	"ipHash"?: string | null;
	/** What happened just before, by event name (the editor's). */
	"breadcrumbs"?: string[];
}

/** Record an occurrence; its id. Tell the owner of a new group, or a surge. */
export async function recordError(env: Bindings, occurrence: Occurrence): Promise<string> {
	const id = newErrorId();
	const now = Date.now();
	const fingerprint = await fingerprintOf(occurrence.source, occurrence.name, occurrence.stack, occurrence.route);
	const message = scrub(occurrence.message, 500);
	const [group] = await env.DB.batch([
		env.DB.prepare(`INSERT INTO errors (fingerprint, source, name, message, route, first_seen, last_seen, count, releases) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
			ON CONFLICT (fingerprint) DO UPDATE SET last_seen = excluded.last_seen, count = count + 1,
				releases = CASE WHEN instr(',' || releases || ',', ',' || excluded.releases || ',') > 0 THEN releases ELSE substr(releases || ',' || excluded.releases, -300) END
			RETURNING first_seen, count`).bind(fingerprint, occurrence.source, occurrence.name.slice(0, 100), message, occurrence.route.slice(0, 200), now, now, occurrence.release),
		env.DB.prepare("INSERT INTO error_occurrences (id, fingerprint, at, route, release, trace_id, grant_id, user_id, message, stack, ip_hash, breadcrumbs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(id, fingerprint, now, occurrence.route.slice(0, 200), occurrence.release, occurrence.traceId ?? null, occurrence.grantId ?? null, occurrence.userId ?? null, message, occurrence.stack === undefined ? null : scrub(occurrence.stack, 4000), occurrence.ipHash ?? null, occurrence.breadcrumbs === undefined || occurrence.breadcrumbs.length === 0 ? null : occurrence.breadcrumbs.join(",").slice(0, 500))
	]);
	const first = (group?.results[0] as { "first_seen": number } | undefined)?.first_seen === now;
	const { tellOwner } = await import("./mail.ts");
	const where = `${occurrence.source === "api" ? "The API" : "The editor"} · ${occurrence.route} · release ${occurrence.release}`;

	if (first) {
		const recent = await env.DB.prepare("SELECT COUNT(*) AS n FROM errors WHERE first_seen > ?").bind(now - 3_600_000).first<{ "n": number }>();

		if ((recent?.n ?? 0) <= 1) {
			await tellOwner(env, `New error: ${occurrence.name}`, `${where}\n${message}\n\nFirst occurrence: ${id}. The admin app's Errors page has its stack and, if signed in, its sign-in. (At most one new-error email an hour: look there for others.)`);
		}
	} else {
		const hour = await env.DB.prepare("SELECT COUNT(*) AS n FROM error_occurrences WHERE fingerprint = ? AND at > ?").bind(fingerprint, now - 3_600_000).first<{ "n": number }>();

		if (hour?.n === SURGE) {
			await tellOwner(env, `Error surging: ${occurrence.name}, ${SURGE} in an hour`, `${where}\n${message}\n\nLatest: ${id}. The admin app's Errors page has the group.`);
		}
	}

	return id;
}

/** The daily cron: occurrences after 30 days, groups 90 days after they were last seen. */
export async function expireErrors(db: D1Database, now = Date.now()): Promise<void> {
	await db.batch([
		db.prepare("DELETE FROM error_occurrences WHERE at < ? OR fingerprint IN (SELECT fingerprint FROM errors WHERE last_seen < ?)").bind(now - 30 * 86_400_000, now - 90 * 86_400_000),
		db.prepare("DELETE FROM errors WHERE last_seen < ?").bind(now - 90 * 86_400_000)
	]);
}

// ── The admin app's Errors page (errors:read) ───────────────────────────────────────────────────────────────────────

/** GET /admin/errors?days=7: the groups seen in the window, most recently seen first, with their count in it. */
export async function errorsEndpoint(context: Context<AppEnv>): Promise<Response> {
	const days = Math.min(Math.max(Number.parseInt(context.req.query("days") ?? "", 10) || 7, 1), 90);
	const since = Date.now() - days * 86_400_000;
	const { results } = await context.env.DB.prepare(`SELECT e.fingerprint, e.source, e.name, e.message, e.route, e.first_seen, e.last_seen, e.count, e.releases,
		(SELECT COUNT(*) FROM error_occurrences o WHERE o.fingerprint = e.fingerprint AND o.at > ?) AS recent
		FROM errors e WHERE e.last_seen > ? ORDER BY e.last_seen DESC LIMIT 200`).bind(since, since).all();

	return context.json({ "days": days, "errors": results });
}

/** GET /admin/errors/:fingerprint: a group, and its latest 100 occurrences. */
export async function errorGroupEndpoint(context: Context<AppEnv>): Promise<Response> {
	const fingerprint = context.req.param("fingerprint") ?? "";
	const [group, occurrences] = await context.env.DB.batch([
		context.env.DB.prepare("SELECT fingerprint, source, name, message, route, first_seen, last_seen, count, releases FROM errors WHERE fingerprint = ?").bind(fingerprint),
		context.env.DB.prepare("SELECT id, at, route, release, trace_id, grant_id, user_id, message FROM error_occurrences WHERE fingerprint = ? ORDER BY at DESC LIMIT 100").bind(fingerprint)
	]);

	return group?.results[0] === undefined ? context.json({ "error": "not_found" }, 404) : context.json({ "error": group.results[0], "occurrences": occurrences?.results ?? [] });
}

/** GET /admin/errors/maps/:release/:path: one of the editor's source maps for a release (O7), kept by production's
 *  deploy (scripts/keep-source-maps.ts): its sources as repo paths, no source text. The admin app maps an editor stack
 *  through them as it shows it; the site never serves them. */
export async function sourceMapEndpoint(context: Context<AppEnv>): Promise<Response> {
	const release = context.req.param("release") ?? "";
	const path = context.req.param("path") ?? "";

	if (!/^[\w.-]{1,40}$/u.test(release) || path.split("/").some((part) => part === ".." || part === "")) {
		return context.json({ "error": "not_found" }, 404);
	}

	const map = await context.env.SOURCE_MAPS.get(`${release}/${path}`);

	// A release's maps never change: the admin app can keep them for the day.
	return map === null ? context.json({ "error": "not_found" }, 404) : context.body(map.body, 200, { "content-type": "application/json", "cache-control": "private, max-age=86400" });
}

/** GET /admin/errors/occurrence/:id: one occurrence, by the id the person quoted (case, the dash and spaces aside). */
export async function errorOccurrenceEndpoint(context: Context<AppEnv>): Promise<Response> {
	const typed = (context.req.param("id") ?? "").toUpperCase().replaceAll(/[\s-]/gu, "").replace(/^E/u, "");
	const id = `E-${typed.slice(0, 4)}-${typed.slice(4)}`;
	const occurrence = await context.env.DB.prepare(`SELECT o.id, o.fingerprint, o.at, o.route, o.release, o.trace_id, o.grant_id, o.user_id, o.message, o.stack, o.breadcrumbs, e.name, e.source, e.count
		FROM error_occurrences o JOIN errors e ON e.fingerprint = o.fingerprint WHERE o.id = ?`).bind(id).first();

	return occurrence === null ? context.json({ "error": "not_found" }, 404) : context.json({ "occurrence": occurrence });
}
