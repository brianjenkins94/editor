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
const PROXIED: { "base": "api" | "git"; "method": string; "template": string; "search"?: string }[] = [
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
