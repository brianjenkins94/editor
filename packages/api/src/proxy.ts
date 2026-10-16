import type { Context } from "hono";
import type { AppEnv } from "./env.ts";
import { audit, origin } from "./audit.ts";
import { github } from "./github.ts";

/**
 * GitHub, for a signed-in browser (README.md, "The proxy"). The browser never holds GitHub's token: it calls these routes
 * with its DPoP-bound access token (the `session` middleware in front), and the Worker calls GitHub with the token the
 * sign-in's Grant keeps. Only what the editor calls is allowed — packages/editor/shell/github.ts for the API, a clone's
 * fetch for git — so a hijacked session can do what the editor does and no more. Anything else is a 403, and audited.
 */

const NAME = "[\\w.-]+";

const REPO = `/repos/${NAME}/${NAME}`;

/** A ref or sha in a path: no `..`, so it can't climb out of the repo it names. */
const REF = "(?!.*\\.\\.)[\\w./-]+";

/** The API calls shell/github.ts makes, by method and path (below /github/api). */
const API: [string, RegExp][] = [
	["GET", /^\/user$/u],
	["POST", /^\/user\/repos$/u],
	["GET", new RegExp(`^${REPO}$`, "u")],
	["GET", new RegExp(`^${REPO}/git/(?:trees|blobs|commits)/${REF}$`, "u")],
	["GET", new RegExp(`^${REPO}/git/ref/${REF}$`, "u")],
	["POST", new RegExp(`^${REPO}/git/(?:blobs|trees|commits)$`, "u")],
	["PATCH", new RegExp(`^${REPO}/git/refs/${REF}$`, "u")],
	["POST", new RegExp(`^${REPO}/pages$`, "u")]
];

/** A clone's two requests (git smart-HTTP, below /github/git): reading only, never a push. */
const GIT: [string, RegExp, string][] = [
	["GET", new RegExp(`^/${NAME}/${NAME}\\.git/info/refs$`, "u"), "?service=git-upload-pack"],
	["POST", new RegExp(`^/${NAME}/${NAME}\\.git/git-upload-pack$`, "u"), ""]
];

/** GitHub's response headers the browser may see: the body's type, caching, and what fido paginates and backs off by. */
const PASSED = ["content-type", "cache-control", "etag", "last-modified", "link", "retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset", "x-ratelimit-used", "x-github-request-id"];

/** The sign-in's GitHub token, or a 401 when the sign-in is over (or GitHub wouldn't refresh it). */
async function token(context: Context<AppEnv>): Promise<string | Response> {
	const value = await context.env.GRANTS.get(context.env.GRANTS.idFromString(context.get("grant"))).githubToken();

	if (value === undefined) {
		context.get("span").info("proxy refused", { "reason": "no GitHub token for this sign-in" });
		context.header("www-authenticate", "DPoP error=\"invalid_token\"");

		return context.json({ "error": "invalid_token" }, 401);
	}

	return value;
}

/** A call the editor never makes: refused, recorded (it alerts), and counted against the sign-in, which a few end. */
async function deny(context: Context<AppEnv>, detail: string): Promise<Response> {
	const from = await origin(context);

	context.get("span").info("proxy refused", { "reason": "not a call the editor makes" });
	await audit(context.env, "proxy_denied", { "userId": context.get("user"), "grantId": context.get("grant") }, from, { "detail": detail });
	await context.env.GRANTS.get(context.env.GRANTS.idFromString(context.get("grant"))).denied({ "from": from });

	return context.json({ "error": "forbidden" }, 403);
}

/**
 * Every call that went through, read or write, recorded before its answer streams (so a dropped connection still leaves
 * the row): what it was and GitHub's status. The bytes it carried back are added once they have (relay). If a session
 * is ever used by something that shouldn't have it, this is the record of what it read and wrote.
 */
async function called(context: Context<AppEnv>, detail: string, status: number): Promise<(bytes: number) => Promise<void>> {
	const row = await audit(context.env, "proxy_call", { "userId": context.get("user"), "grantId": context.get("grant") }, await origin(context), { "reason": `GitHub ${status}`, "detail": detail });

	return async (bytes) => {
		await context.env.DB.prepare("UPDATE audit SET reason = ? WHERE id = ?").bind(`GitHub ${status}, ${bytes} bytes`, row).run();
	};
}

/**
 * One of the sign-in's in-flight slots (the Grant's lease()), or a 429 when it has them all in use: recorded, and so
 * alerted, as a rate limit (`PROXY_CONCURRENCY`). The slot goes back when the answer has streamed (relay).
 */
async function slot(context: Context<AppEnv>): Promise<{ "release": () => Promise<void> } | Response> {
	const grant = context.env.GRANTS.get(context.env.GRANTS.idFromString(context.get("grant")));
	const lease = await grant.lease();

	if (lease === undefined) {
		context.get("span").info("proxy refused", { "reason": "too many requests in flight" });
		await audit(context.env, "rate_limited", { "userId": context.get("user"), "grantId": context.get("grant") }, await origin(context), { "reason": "PROXY_CONCURRENCY", "detail": `${context.req.method} ${new URL(context.req.url).pathname}` });
		context.header("retry-after", "1");

		return context.json({ "error": "rate_limited" }, 429);
	}

	return { "release": async () => grant.release(lease) };
}

/** GitHub's answer, streamed, with only PASSED headers; `link` pointed back here so pagination stays on the proxy. Once
 *  the body has streamed through (or at once, with none), its bytes are recorded and its slot released. */
function relay(upstream: Response, rewrite: [string, string], release: () => Promise<void>, counted: (bytes: number) => Promise<void>): Response {
	const headers = new Headers();

	for (const name of PASSED) {
		const value = upstream.headers.get(name);

		if (value !== null) {
			headers.set(name, name === "link" ? value.replaceAll(rewrite[0], rewrite[1]) : value);
		}
	}

	if (upstream.body === null) {
		void release();
		void counted(0);

		return new Response(null, { "status": upstream.status, "headers": headers });
	}

	let bytes = 0;

	return new Response(upstream.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
		"transform": (chunk, controller) => {
			bytes += chunk.byteLength;
			controller.enqueue(chunk);
		},
		"flush": async () => {
			await counted(bytes);
			await release();
		}
	})), { "status": upstream.status, "headers": headers });
}

/** /github/api/* → api.github.com/*, for the calls in API. */
export async function githubApi(context: Context<AppEnv>): Promise<Response> {
	const url = new URL(context.req.url);
	const path = url.pathname.slice("/github/api".length);
	const method = context.req.method;

	if (!API.some(([allowed, pattern]) => allowed === method && pattern.test(path))) {
		return deny(context, `${method} ${path}`);
	}

	const bearer = await token(context);

	if (bearer instanceof Response) {
		return bearer;
	}

	const held = await slot(context);

	if (held instanceof Response) {
		return held;
	}

	const { api } = github(context.env);
	const upstream = await fetch(`${api}${path}${url.search}`, {
		"method": method,
		"headers": {
			"authorization": `Bearer ${bearer}`,
			"accept": context.req.header("accept") ?? "application/vnd.github+json",
			"x-github-api-version": "2022-11-28",
			"user-agent": "editor-api",
			...context.req.header("content-type") === undefined ? {} : { "content-type": context.req.header("content-type") as string }
		},
		...method === "GET" ? {} : { "body": context.req.raw.body }
	}).catch(async (error: unknown) => {
		await held.release();
		throw error;
	});

	return relay(upstream, [api, `${url.origin}/github/api`], held.release, await called(context, `${method} ${path}${url.search}`, upstream.status));
}

/** /github/git/<owner>/<repo>.git/… → github.com, for a clone's info/refs and git-upload-pack. */
export async function githubGit(context: Context<AppEnv>): Promise<Response> {
	const url = new URL(context.req.url);
	const path = url.pathname.slice("/github/git".length);
	const method = context.req.method;

	if (!GIT.some(([allowed, pattern, search]) => allowed === method && pattern.test(path) && url.search === search)) {
		return deny(context, `${method} ${path}${url.search}`);
	}

	const bearer = await token(context);

	if (bearer instanceof Response) {
		return bearer;
	}

	const held = await slot(context);

	if (held instanceof Response) {
		return held;
	}

	const { web } = github(context.env);
	const upstream = await fetch(`${web}${path}${url.search}`, {
		"method": method,
		"headers": {
			// git over HTTP takes a token as a password; the user name is anything.
			"authorization": `Basic ${btoa(`x-access-token:${bearer}`)}`,
			"user-agent": "git/editor-api",
			"accept": context.req.header("accept") ?? "*/*",
			...context.req.header("content-type") === undefined ? {} : { "content-type": context.req.header("content-type") as string }
		},
		...method === "GET" ? {} : { "body": context.req.raw.body }
	}).catch(async (error: unknown) => {
		await held.release();
		throw error;
	});

	return relay(upstream, [web, `${url.origin}/github/git`], held.release, await called(context, `${method} ${path}${url.search}`, upstream.status));
}
