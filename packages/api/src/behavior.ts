import { base64url } from "jose";
import type { Bindings } from "./env.ts";

/**
 * Behavior (BEHAVIOR.md, B7): what a request is, and what a sign-in's client looks like. Zero-knowledge: a request is
 * kept as its route template with a keyed hash of its values, a client as which headers it sent with a keyed hash of
 * each, never the values themselves.
 */

/** An HMAC of `value` under AUDIT_KEY and `scope`, shortened: equal values compare equal, but it can't be read back.
 *  "Was it repository X?" is answered by hashing X the same way. */
export async function keyed(env: Bindings, scope: string, value: string): Promise<string> {
	const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(`${env.AUDIT_KEY}:${scope}`), { "name": "HMAC", "hash": "SHA-256" }, false, ["sign"]);

	return base64url.encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)))).slice(0, 22);
}

// ── Actions ────────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The GitHub calls the editor makes (packages/editor/shell/github.ts for the API, a clone's fetch for git), as templates:
 * the proxy allows these and nothing else (src/proxy.ts), and records each call as its template. `:owner` and `:repo` are
 * names, `:ref` a ref or sha (no `..`, so it can't climb out of the repository it names). A git entry also names the
 * query it must have.
 */
export const PROXIED: { "base": "api" | "git"; "method": string; "template": string; "search"?: string }[] = [
	{ "base": "api", "method": "GET", "template": "/user" },
	{ "base": "api", "method": "POST", "template": "/user/repos" },
	{ "base": "api", "method": "GET", "template": "/repos/:owner/:repo" },
	{ "base": "api", "method": "GET", "template": "/repos/:owner/:repo/git/trees/:ref" },
	{ "base": "api", "method": "GET", "template": "/repos/:owner/:repo/git/blobs/:ref" },
	{ "base": "api", "method": "GET", "template": "/repos/:owner/:repo/git/commits/:ref" },
	{ "base": "api", "method": "GET", "template": "/repos/:owner/:repo/git/ref/:ref" },
	{ "base": "api", "method": "POST", "template": "/repos/:owner/:repo/git/blobs" },
	{ "base": "api", "method": "POST", "template": "/repos/:owner/:repo/git/trees" },
	{ "base": "api", "method": "POST", "template": "/repos/:owner/:repo/git/commits" },
	{ "base": "api", "method": "PATCH", "template": "/repos/:owner/:repo/git/refs/:ref" },
	{ "base": "api", "method": "POST", "template": "/repos/:owner/:repo/pages" },
	{ "base": "git", "method": "GET", "template": "/:owner/:repo.git/info/refs", "search": "?service=git-upload-pack" },
	{ "base": "git", "method": "POST", "template": "/:owner/:repo.git/git-upload-pack", "search": "" }
];

const PARAMETERS: Record<string, string> = { ":owner": "([\\w.-]+)", ":repo": "([\\w.-]+)", ":ref": "((?!.*\\.\\.)[\\w./-]+)" };

/** Each template as the pattern it matches, its parameters capturing. */
const MATCHERS = PROXIED.map((entry) => ({ ...entry, "pattern": new RegExp(`^${entry.template.split(/(:owner|:repo|:ref)/u).map((part) => PARAMETERS[part] ?? part.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&")).join("")}$`, "u") }));

/**
 * A proxied call as the editor makes it: its template (with the query's parameter names, never their values), the
 * repository it's about (`owner/repo`), and the rest of its values (a ref, the query), each to be hashed apart, so the
 * calls about one repository can be found by hashing its name. Undefined: not a call the editor makes.
 */
export function proxied(base: "api" | "git", method: string, path: string, search: string): { "template": string; "repository"?: string; "rest": string } | undefined {
	for (const entry of MATCHERS) {
		const match = entry.base === base && entry.method === method && (entry.search === undefined || entry.search === search) ? entry.pattern.exec(path) : null;

		if (match !== null) {
			const names = [...new URLSearchParams(search).keys()];
			const [owner, repo, ...rest] = match.slice(1);

			return { "template": `${method} ${entry.template}${names.length === 0 ? "" : `?${names.join("&")}`}`, ...repo === undefined ? {} : { "repository": `${owner}/${repo}` }, "rest": [...rest, search].filter((value) => value !== "").join("\n") };
		}
	}

	return undefined;
}

/** How a repository is named in the log: `repo#` and its keyed hash (what `?repo=` on /admin/audit looks for). */
export async function repositoryTag(env: Bindings, repository: string): Promise<string> {
	return `repo#${await keyed(env, "values", repository.toLowerCase())}`;
}

/**
 * How a request is written into the audit log: `METHOD /path` for our own routes (their ids are ours), and for the
 * proxy, the template, its repository's tag (`repo#…`) and a keyed hash of its other values (`#…`), or for a call that
 * isn't one the editor makes, the hash of its path only. Never a repository's name.
 */
export async function described(env: Bindings, method: string, url: URL): Promise<string> {
	const base = url.pathname.startsWith("/github/api/") ? "api" : url.pathname.startsWith("/github/git/") ? "git" : undefined;

	if (base === undefined) {
		return `${method} ${url.pathname}`;
	}

	const path = url.pathname.slice(`/github/${base}`.length);
	const call = proxied(base, method, path, url.search);

	if (call === undefined) {
		return `${method} /github/${base}/… #${await keyed(env, "values", path + url.search)}`;
	}

	return [call.template, call.repository === undefined ? undefined : await repositoryTag(env, call.repository), call.rest === "" ? undefined : `#${await keyed(env, "values", call.rest)}`].filter((part) => part !== undefined).join(" ");
}

// ── A sign-in's client ─────────────────────────────────────────────────────────────────────────────────────────────

/** The headers a sign-in's client is known by: whether it sent each, and a keyed hash of the value. */
const HEADERS = ["origin", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "user-agent", "sec-ch-ua", "sec-ch-ua-platform", "sec-ch-ua-mobile", "accept-language", "accept-encoding"] as const;

/** And what the User-Agent says, kept in clear (the device label says as much): the browser, its major version, the OS. */
const AGENT = ["browser", "major", "os"] as const;

/** Header (or agent part) → its keyed hash (or, for the agent, its value), or null when it wasn't sent. */
export type Fingerprint = Record<string, string | null>;

/** The browser, its major version and the OS, from a User-Agent, and nothing more of it. */
export function agentOf(userAgent: string | undefined): { "browser": string; "major": string | null; "os": string | null } | undefined {
	if (userAgent === undefined || userAgent === "") {
		return undefined;
	}

	// In this order: Edge's User-Agent names Chrome and Safari too, Chrome's names Safari, an iPad's names Mac OS X.
	const [browser, version] = /Edg\//u.test(userAgent) ? ["Edge", /Edg\/(\d+)/u] as const
		: /Firefox\//u.test(userAgent) ? ["Firefox", /Firefox\/(\d+)/u] as const
			: /Chrome\//u.test(userAgent) ? ["Chrome", /Chrome\/(\d+)/u] as const
				: /Safari\//u.test(userAgent) ? ["Safari", /Version\/(\d+)/u] as const : ["A browser", undefined] as const;
	const os = /iPhone|iPad/u.test(userAgent) ? "iOS" : /Android/u.test(userAgent) ? "Android" : /Mac OS X/u.test(userAgent) ? "macOS" : /Windows/u.test(userAgent) ? "Windows" : /Linux/u.test(userAgent) ? "Linux" : null;

	return { "browser": browser, "major": version?.exec(userAgent)?.[1] ?? null, "os": os };
}

/** A request's fingerprint, its hashes keyed to the sign-in (so they compare within it, and can't be matched across). */
export async function fingerprint(env: Bindings, grantId: string, headers: Headers): Promise<Fingerprint> {
	const print: Fingerprint = {};

	for (const name of HEADERS) {
		const value = headers.get(name);

		print[name] = value === null ? null : await keyed(env, `header:${grantId}`, value);
	}

	const agent = agentOf(headers.get("user-agent") ?? undefined);

	for (const part of AGENT) {
		print[part] = agent?.[part] ?? null;
	}

	return print;
}

/**
 * What kind of client sent it: a browser's fetch from one of our apps carries Origin (it's cross-origin) and Fetch
 * Metadata; a script usually sends neither. What's missing, when it isn't a browser's.
 */
export function clientKind(print: Fingerprint): { "kind": "browser" } | { "kind": "other"; "missing": string[] } {
	const missing = ["origin", "sec-fetch-mode"].filter((name) => print[name] === null);

	return missing.length === 0 ? { "kind": "browser" } : { "kind": "other", "missing": missing };
}

/** One header (or agent part) that isn't as it was, and how much that matters. */
export interface Difference {
	"name": string;
	"kind": "changed" | "omitted" | "added";
	"strength": "strong" | "medium" | "tolerated";
}

/** Headers that change when the browser updates. */
const AGENT_HEADERS = new Set(["user-agent", "sec-ch-ua", "sec-ch-ua-platform", "sec-ch-ua-mobile"]);

/**
 * How `now` differs from the sign-in's `base`. Strong: Origin or Fetch Metadata omitted (a browser became something
 * else), the browser or OS changed, the major version went down. Tolerated: a header added (a new release of the editor
 * or the browser sending something new), and the browser updating (its headers changed, the browser and OS the same,
 * the major version the same or up). Anything else is medium.
 */
export function differences(base: Fingerprint, now: Fingerprint): Difference[] {
	const updated = base["browser"] === now["browser"] && base["os"] === now["os"] && Number(now["major"] ?? 0) >= Number(base["major"] ?? 0);
	const found: Difference[] = [];

	for (const name of [...HEADERS, ...AGENT]) {
		const before = base[name] ?? null;
		const after = now[name] ?? null;

		if (before === after) {
			continue;
		}

		const kind = before === null ? "added" : after === null ? "omitted" : "changed";
		const strength = kind === "added" ? "tolerated"
			: (name === "origin" || name.startsWith("sec-fetch-")) && kind === "omitted" ? "strong"
				: name === "browser" || name === "os" ? "strong"
					: name === "major" ? (kind === "changed" && Number(after) < Number(before) ? "strong" : kind === "changed" ? "tolerated" : "medium")
						: AGENT_HEADERS.has(name) && kind === "changed" && updated ? "tolerated" : "medium";

		found.push({ "name": name, "kind": kind, "strength": strength });
	}

	return found;
}

// ── The likely next action (B8) ────────────────────────────────────────────────────────────────────────────────────

/**
 * What a signed-in request is, as the model counts it: `METHOD /route` with the router's template (`route`, Hono's
 * `routePath(c, -1)`), the proxy's template for a proxied call, and for a request that matched no route of its own
 * (only a wildcard middleware did), `METHOD (no such route)`.
 */
export function actionOf(method: string, url: URL, route: string): string {
	const base = url.pathname.startsWith("/github/api/") ? "api" : url.pathname.startsWith("/github/git/") ? "git" : undefined;

	if (base !== undefined) {
		const call = proxied(base, method, url.pathname.slice(`/github/${base}`.length), url.search);

		return call === undefined ? `${method} /github/${base}/… (refused)` : `${method} /github/${base}${call.template.slice(method.length + 1)}`;
	}

	return route.endsWith("*") ? `${method} (no such route)` : `${method} ${route}`;
}

/** Where a sign-in's chain starts: before its first request. */
export const START = "(start)";

/** The gap since the sign-in's last request, coarsely: under 100 ms, under 1 s, under 10 s, longer. */
export function gapOf(milliseconds: number): number {
	return milliseconds < 100 ? 0 : milliseconds < 1000 ? 1 : milliseconds < 10_000 ? 2 : 3;
}

const GAPS = 4;

/**
 * What the editor and the admin app do, in order (packages/editor/shell/github.ts, git-clone.ts, session.ts;
 * packages/admin/src): the model's prior, so it starts from the code rather than from nothing, and so a flow that's in
 * the code is never unusual however few people have used it yet. Each step is counted PRIOR_WEIGHT times: enough that
 * every action in a flow can be scored from the first day (OBSERVED).
 */
export const FLOWS: string[][] = [
	// Signing in to the editor: the code redeemed, then who it is.
	[START, "POST /token", "GET /github/api/user"],
	// Opening a repository: what it is, then a clone.
	["GET /github/api/user", "GET /github/api/repos/:owner/:repo", "GET /github/git/:owner/:repo.git/info/refs?service", "POST /github/git/:owner/:repo.git/git-upload-pack"],
	// Or through the API: its tree, then each blob.
	["GET /github/api/repos/:owner/:repo", "GET /github/api/repos/:owner/:repo/git/trees/:ref?recursive", "GET /github/api/repos/:owner/:repo/git/blobs/:ref", "GET /github/api/repos/:owner/:repo/git/blobs/:ref"],
	// Committing: the branch, its commit, each blob, a tree, the commit, the branch moved.
	["GET /github/api/repos/:owner/:repo/git/ref/:ref", "GET /github/api/repos/:owner/:repo/git/commits/:ref", "POST /github/api/repos/:owner/:repo/git/blobs", "POST /github/api/repos/:owner/:repo/git/blobs", "POST /github/api/repos/:owner/:repo/git/trees", "POST /github/api/repos/:owner/:repo/git/commits", "PATCH /github/api/repos/:owner/:repo/git/refs/:ref"],
	// A new repository, its first commit, then published.
	["GET /github/api/user", "POST /github/api/user/repos", "GET /github/api/repos/:owner/:repo/git/ref/:ref"],
	["PATCH /github/api/repos/:owner/:repo/git/refs/:ref", "POST /github/api/repos/:owner/:repo/pages"],
	// Your sign-ins, and your account.
	["GET /sessions", "POST /sessions/:id/revoke"],
	["GET /sessions", "POST /sessions/revoke-all"],
	["GET /sessions", "POST /account/delete"],
	// The admin app: who you are, the overview's reads, then a page.
	[START, "POST /token", "GET /admin/me", "GET /admin/users", "GET /admin/users", "GET /admin/sessions", "GET /admin/audit"],
	["GET /admin/users", "GET /admin/users/:id"],
	["GET /admin/sessions", "POST /admin/sessions/:id/revoke"],
	["GET /admin/me", "GET /admin/traffic"]
];

const PRIOR_WEIGHT = 20;

/** FLOWS as counts: from → to → weight. */
const PRIOR = new Map<string, Map<string, number>>();

for (const flow of FLOWS) {
	for (let index = 1; index < flow.length; index += 1) {
		const next = PRIOR.get(flow[index - 1] as string) ?? new Map<string, number>();

		next.set(flow[index] as string, (next.get(flow[index] as string) ?? 0) + PRIOR_WEIGHT);
		PRIOR.set(flow[index - 1] as string, next);
	}
}

/** A transition: from one action to the next, with the gap between them. */
export interface Step { "from": string; "to": string; "gap": number }

/** What's known of the transitions a score needs: the counts out of their actions, how common each action is, and when
 *  each was first seen. */
export interface Model {
	/** `from\nto\ngap` → count. */
	"counts": Map<string, number>;
	/** from → its transitions' total. */
	"out": Map<string, number>;
	/** to → how often it was the next action, from anything. */
	"into": Map<string, number>;
	"total": number;
	"firstSeen": Map<string, number>;
}

/** A transition is scored once its starting action has this much behind it (counts and prior together). */
const OBSERVED = 20;

/** An action first seen this recently is new: a transition into it scores at most NEW_CAP. */
const NEW_DAYS = 7;

const NEW_CAP = 4;

/**
 * How surprising a transition is, in bits: −log₂ of its probability. The next action's probability is its count out of
 * `from` plus the prior, smoothed toward how common the action is anywhere (so an action that's common but never
 * followed this one isn't impossible); the gap's is add-one over its four buckets. Undefined when `from` hasn't enough
 * behind it to say. A new action's surprise is capped: a feature that just shipped isn't unusual.
 */
export function surprisal(model: Model, step: Step, now = Date.now()): number | undefined {
	const prior = PRIOR.get(step.from);
	const priorOut = [...prior?.values() ?? []].reduce((sum, weight) => sum + weight, 0);
	const out = (model.out.get(step.from) ?? 0) + priorOut;

	if (out < OBSERVED) {
		return undefined;
	}

	const pair = [0, 1, 2, 3].reduce((sum, gap) => sum + (model.counts.get(`${step.from}\n${step.to}\n${gap}`) ?? 0), 0);
	const anywhere = ((model.into.get(step.to) ?? 0) + 1) / (model.total + model.into.size + 1);
	const next = (pair + (prior?.get(step.to) ?? 0) + anywhere) / (out + 1);
	const gap = ((model.counts.get(`${step.from}\n${step.to}\n${step.gap}`) ?? 0) + 1) / (pair + GAPS);
	const bits = -Math.log2(next * gap);
	const seen = model.firstSeen.get(step.to);

	return seen === undefined || now - seen < NEW_DAYS * 86_400_000 ? Math.min(bits, NEW_CAP) : bits;
}

/** The most surprising transitions a score keeps. */
const TOP = 5;

/**
 * A sign-in's transitions since its last flush (the Grant's, hourly): scored against the model as it is (so a sign-in
 * never explains itself), its score updated, then added to the model. Says how many were scored.
 */
export async function learn(db: D1Database, grantId: string, pending: (Step & { "count": number })[], now = Date.now()): Promise<number> {
	if (pending.length === 0) {
		return 0;
	}

	const froms = [...new Set(pending.map((step) => step.from))];
	const tos = [...new Set(pending.map((step) => step.to))];
	const [counts, into, seen, score] = await db.batch([
		db.prepare(`SELECT from_action, to_action, gap, count FROM transitions WHERE from_action IN (${froms.map(() => "?").join(", ")})`).bind(...froms),
		// How common each action is: the whole table, summed. Small while the vocabulary is.
		db.prepare("SELECT to_action, SUM(count) AS count FROM transitions GROUP BY to_action"),
		db.prepare(`SELECT action, first_seen FROM actions WHERE action IN (${tos.map(() => "?").join(", ")})`).bind(...tos),
		db.prepare("SELECT steps, bits, top FROM scores WHERE grant_id = ?").bind(grantId)
	]);
	const model: Model = { "counts": new Map(), "out": new Map(), "into": new Map(), "total": 0, "firstSeen": new Map() };

	for (const row of (counts?.results ?? []) as { "from_action": string; "to_action": string; "gap": number; "count": number }[]) {
		model.counts.set(`${row.from_action}\n${row.to_action}\n${row.gap}`, row.count);
		model.out.set(row.from_action, (model.out.get(row.from_action) ?? 0) + row.count);
	}

	for (const row of (into?.results ?? []) as { "to_action": string; "count": number }[]) {
		model.into.set(row.to_action, row.count);
		model.total += row.count;
	}

	for (const row of (seen?.results ?? []) as { "action": string; "first_seen": number }[]) {
		model.firstSeen.set(row.action, row.first_seen);
	}

	const before = (score?.results[0] ?? { "steps": 0, "bits": 0, "top": "[]" }) as { "steps": number; "bits": number; "top": string };
	let steps = before.steps;
	let bits = before.bits;
	let top = JSON.parse(before.top) as (Step & { "bits": number })[];
	let scored = 0;

	for (const step of pending) {
		const surprise = surprisal(model, step, now);

		if (surprise !== undefined) {
			steps += step.count;
			bits += surprise * step.count;
			scored += step.count;
			top.push({ "from": step.from, "to": step.to, "gap": step.gap, "bits": Math.round(surprise * 100) / 100 });
		}
	}

	top = top.sort((a, b) => b.bits - a.bits).slice(0, TOP);

	await db.batch([
		...pending.map((step) => db.prepare("INSERT INTO transitions (from_action, to_action, gap, count) VALUES (?, ?, ?, ?) ON CONFLICT (from_action, to_action, gap) DO UPDATE SET count = count + excluded.count").bind(step.from, step.to, step.gap, step.count)),
		...tos.map((action) => db.prepare("INSERT INTO actions (action, first_seen) VALUES (?, ?) ON CONFLICT (action) DO NOTHING").bind(action, now)),
		db.prepare("INSERT INTO scores (grant_id, steps, bits, top, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (grant_id) DO UPDATE SET steps = excluded.steps, bits = excluded.bits, top = excluded.top, updated_at = excluded.updated_at").bind(grantId, steps, bits, JSON.stringify(top), now)
	]);

	return scored;
}

/** Each day the counts fade (a half-life of about three weeks), so the model follows the product; what fades to
 *  almost nothing goes. Says how many transitions went. */
export async function decay(db: D1Database): Promise<number> {
	const [, removed] = await db.batch([
		db.prepare("UPDATE transitions SET count = count * 0.97"),
		db.prepare("DELETE FROM transitions WHERE count < 0.05")
	]);

	return removed?.meta.changes ?? 0;
}
