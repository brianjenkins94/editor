import type { Context } from "hono";
import type { AppEnv, Bindings } from "./env.ts";
import { routePath } from "hono/route";
import { audit, origin } from "./audit.ts";

/**
 * The tripwire (README.md, O3): no one reads another person's data, and if they find a way, it's an
 * incident. Every request made through a user's sign-in gets a watched D1 binding (`watch`, from the session middleware,
 * src/tokens.ts): every row a query returns is looked at, and a row naming another user (its `user_id`), or any value
 * that is the canary account's, is a breach. Admin routes that read across users by a permission lift the watch
 * (`requires`, src/rbac.ts); the few reads that look at another account on purpose say so (`crossUser`, with why).
 *
 * A breach: the request answered 500 with nothing in it, every sign-in of the user who made it ended, the kill switch
 * on, the owner emailed, and a `tripwire` audit row (the route, the query's text, never its values, both users). Until
 * ENFORCE_FROM a row naming another user is only reported (`tripwire_report`, the owner emailed at most hourly), so a
 * legitimate read missed in review can't take the API down; the canary trips from the start.
 */

/** When another user's row stops being reported and starts tripping: a week after the tripwire shipped (2026-10-19). */
export const ENFORCE_FROM = Date.UTC(2026, 9, 26);

interface Finding { "kind": "canary" | "another user's row"; "sql": string; "other": string }

export interface Watch { "user": string; "raw": D1Database; "canary": Set<string>; "enforce": boolean; "breach"?: Finding; "reports": Finding[] }

const RAW = Symbol("raw");

/** Each watched statement's SQL, for a batch's findings (a statement doesn't carry its text). */
const SQL = new WeakMap<object, string>();

/** The canary account's ids (its user, its identity's address, its sign-in), derived from AUDIT_KEY, so the public
 *  repo doesn't name them. Once per isolate. */
let canaryIds: Promise<{ "user": string; "email": string; "grant": string }> | undefined;

export function canary(env: Bindings): Promise<{ "user": string; "email": string; "grant": string }> {
	canaryIds ??= (async () => {
		const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${env.AUDIT_KEY}:canary`), { "name": "HMAC", "hash": "SHA-256" }, false, ["sign"]);
		const hex = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode("canary")))].map((byte) => byte.toString(16).padStart(2, "0")).join("");

		return { "user": `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`, "email": `canary-${hex.slice(32, 40)}@unusuallygood.dev`, "grant": `${hex}${hex}`.slice(0, 64) };
	})();

	return canaryIds;
}

/** Make sure the canary account exists (the hourly cron): a user, an email identity and a live sign-in that no real flow
 *  ever touches. */
export async function ensureCanary(env: Bindings): Promise<void> {
	const ids = await canary(env);
	const now = Date.now();

	await env.DB.batch([
		env.DB.prepare("INSERT OR IGNORE INTO users (id, created_at) VALUES (?, ?)").bind(ids.user, now),
		env.DB.prepare("INSERT OR IGNORE INTO identities (provider, subject, user_id, created_at, verified_at) VALUES ('email', ?, ?, ?, ?)").bind(ids.email, ids.user, now, now),
		env.DB.prepare("INSERT OR IGNORE INTO grants (id, user_id, created_at, last_used_at, label, client, method) VALUES (?, ?, ?, ?, 'canary', 'editor', 'email')").bind(ids.grant, ids.user, now, now)
	]);
}

/** Look at what a query returned: a value that's the canary's, or a `user_id` that isn't the signed-in user's. */
function inspect(watch: Watch, sql: string, rows: unknown[]): void {
	for (const row of rows) {
		if (row === null || typeof row !== "object") {
			continue;
		}

		for (const [column, value] of Object.entries(row)) {
			const finding: Finding | undefined = typeof value === "string" && watch.canary.has(value) ? { "kind": "canary", "sql": sql, "other": value }
				: column === "user_id" && typeof value === "string" && value !== watch.user ? { "kind": "another user's row", "sql": sql, "other": value } : undefined;

			if (finding === undefined) {
				continue;
			}

			if (finding.kind === "canary" || watch.enforce) {
				watch.breach ??= finding;

				throw new Breach(finding);
			}

			watch.reports.push(finding);
		}
	}
}

/** What a breach throws, so the handler stops; the watch remembers it even if the handler catches it. */
export class Breach extends Error {
	public readonly finding: Finding;

	public constructor(finding: Finding) {
		super("tripwire");
		this.name = "Breach";
		this.finding = finding;
	}
}

function watchStatement(statement: D1PreparedStatement, sql: string, watch: Watch): D1PreparedStatement {
	const proxy = new Proxy(statement, {
		"get": (target, property) => {
			if (property === RAW) {
				return target;
			}

			if (property === "bind") {
				return (...values: unknown[]) => watchStatement(target.bind(...values), sql, watch);
			}

			if (property === "first") {
				return async (column?: string) => {
					const row = await target.first<Record<string, unknown>>();

					inspect(watch, sql, row === null ? [] : [row]);

					return column === undefined ? row : row?.[column] ?? null;
				};
			}

			if (property === "all") {
				return async () => {
					const result = await target.all();

					inspect(watch, sql, result.results);

					return result;
				};
			}

			if (property === "raw") {
				return async (options?: { "columnNames"?: boolean }) => {
					const rows = await target.raw(options as { "columnNames": true });

					// Values only (no column names): the canary still shows.
					inspect(watch, sql, rows.map((values) => Object.fromEntries((values as unknown[]).map((value, index) => [`_${index}`, value]))));

					return rows;
				};
			}

			const value = Reflect.get(target, property, target) as unknown;

			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		}
	});

	SQL.set(proxy, sql);

	return proxy;
}

/** A watched D1 binding for `user`'s request. */
export function watched(db: D1Database, watch: Watch): D1Database {
	return new Proxy(db, {
		"get": (target, property) => {
			if (property === RAW) {
				return target;
			}

			if (property === "prepare") {
				return (sql: string) => watchStatement(target.prepare(sql), sql, watch);
			}

			if (property === "batch") {
				return async (statements: D1PreparedStatement[]) => {
					const results = await target.batch(statements.map((statement) => (statement as unknown as Record<symbol, D1PreparedStatement>)[RAW] ?? statement));

					results.forEach((result, index) => {
						inspect(watch, SQL.get(statements[index] as object) ?? "batch", result.results ?? []);
					});

					return results;
				};
			}

			const value = Reflect.get(target, property, target) as unknown;

			return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
		}
	});
}

/** The unwatched binding, for a read that looks at another account on purpose; `_why` says what for, where it's called
 *  (reviewed like roles are). Unwatched already, it's the binding as given. */
export function crossUser(db: D1Database, _why: string): D1Database {
	return (db as unknown as Record<symbol, D1Database>)[RAW] ?? db;
}

/** The request's env, its D1 unwatched again: what a permission to read across users lifts (src/rbac.ts). */
export function unwatched(env: Bindings): Bindings {
	const raw = (env.DB as unknown as Record<symbol, D1Database>)[RAW];

	return raw === undefined ? env : { ...env, "DB": raw };
}

/** Watch the rest of this request, made through `user`'s sign-in (src/tokens.ts). After it: a breach answered and acted
 *  on, a report recorded. */
export async function watch(context: Context<AppEnv>, next: () => Promise<void>): Promise<void> {
	const raw = context.env.DB;
	// Enforcing: from ENFORCE_FROM, and always locally (`TRIPWIRE: "enforce"`, wrangler.jsonc's local vars), so a test
	// that reads another user's row fails instead of being reported.
	const enforce = Date.now() >= ENFORCE_FROM || context.env.TRIPWIRE === "enforce";
	const state: Watch = { "user": context.get("user"), "raw": raw, "canary": new Set(Object.values(await canary(context.env))), "enforce": enforce, "reports": [] };

	context.env = { ...context.env, "DB": watched(raw, state) };

	try {
		await next();
	} finally {
		context.env = { ...context.env, "DB": raw };
	}

	if (state.breach !== undefined) {
		context.res = await breached(context, state.breach);
	} else if (state.reports.length > 0) {
		await reported(context, state.reports);
	}
}

const route = (context: Context<AppEnv>): string => `${context.req.method} ${routePath(context, -1)}`;

/** A breach: everything the user's sign-ins could do, stopped; the API down; the owner told. Nothing in the answer. */
async function breached(context: Context<AppEnv>, finding: Finding): Promise<Response> {
	// Here, not above: src/rbac.ts (which Node tests import) imports this module, and mail.ts imports its templates.
	const [{ tellOwner }, { setMaintenance }] = await Promise.all([import("./mail.ts"), import("./maintenance.ts")]);
	const user = context.get("user");
	const from = await origin(context);
	const { results } = await context.env.DB.prepare("SELECT id FROM grants WHERE user_id = ? AND revoked_at IS NULL").bind(user).all<{ "id": string }>();

	for (const { id } of results) {
		await context.env.GRANTS.get(context.env.GRANTS.idFromString(id)).revoke({ "from": from, "reason": "tripwire" });
	}

	await audit(context.env, "tripwire", { "userId": user, "grantId": context.get("grant") }, from, { "reason": finding.kind, "detail": `${route(context)} · ${finding.sql.slice(0, 300)} · read ${finding.other}` });
	await setMaintenance(context.env, true, `tripwire: ${finding.kind} read on ${route(context)}`, "tripwire");
	await tellOwner(context.env, "Tripwire: someone read data that isn't theirs", [
		`${finding.kind === "canary" ? "The canary account's data" : "Another user's row"} came back to a request made through user ${user}'s sign-in.`,
		`Route: ${route(context)}`,
		`Query: ${finding.sql.slice(0, 300)}`,
		`Read: ${finding.other}`,
		`${results.length} sign-in(s) of that user ended; the kill switch is on. The audit log has a tripwire row; the trace id finds the request in Cloudflare's logs.`
	].join("\n"));
	context.header("cache-control", "no-store");

	return context.json({ "error": "internal" }, 500);
}

/** Before ENFORCE_FROM: another user's row reported, not tripped; the owner emailed at most hourly. */
async function reported(context: Context<AppEnv>, findings: Finding[]): Promise<void> {
	const [finding] = findings;

	if (finding === undefined) {
		return;
	}

	const { tellOwner } = await import("./mail.ts");

	await audit(context.env, "tripwire_report", { "userId": context.get("user"), "grantId": context.get("grant") }, await origin(context), { "reason": finding.kind, "detail": `${route(context)} · ${finding.sql.slice(0, 300)} · read ${finding.other}` });

	const recent = await context.env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE event = 'tripwire_report' AND at > ?").bind(Date.now() - 3_600_000).first<{ "n": number }>();

	if ((recent?.n ?? 0) <= 1) {
		await tellOwner(context.env, "Tripwire report: a read of another user's row", `Reported, not tripped (it enforces from ${new Date(ENFORCE_FROM).toISOString().slice(0, 10)}): a legitimate read missed in review, or a real one.\n\nRoute: ${route(context)}\nQuery: ${finding.sql.slice(0, 300)}\nUser: ${context.get("user")}, read: ${finding.other}\n\nIf it's legitimate, mark it crossUser(…) in code (src/tripwire.ts); if not, turn the kill switch on.`);
	}
}
