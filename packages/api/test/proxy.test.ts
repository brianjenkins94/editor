import type { AddressInfo } from "node:net";
import type { IncomingHttpHeaders } from "node:http";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { base64url, calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTestHarness } from "wrangler";
import type { Copy, Row } from "../src/audit-copies.ts";
import { compare, copyKey, parseKey } from "../src/audit-copies.ts";
import { BROWSER } from "./browser.ts";
import { keyed } from "../src/behavior.ts";
import { accessTokenHash as s256 } from "@brianjenkins94/util/auth/dpop";

// The GitHub proxy in workerd (README.md, "The proxy"): a signed-in browser's calls go through with the sign-in's GitHub
// token, refreshed when it's close to expiring; anything the editor doesn't call is refused; sizes are capped.

const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "test" };
const secrets = {
	"SIGNING_JWK": JSON.stringify(signing),
	"NONCE_KEY": "nonce key for the tests",
	"TOKEN_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"AUDIT_KEY": "audit key for the tests",
	"STATE_KEY": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"GITHUB_CLIENT_SECRET": `client-secret-${crypto.randomUUID()}`
};

/** GitHub, as the proxy sees it: every request kept, refreshes answered as `refresh` says. */
const seen: { "method": string; "url": string; "headers": IncomingHttpHeaders; "body": string }[] = [];
let refresh: "ok" | "refused" = "ok";
let refreshes = 0;
const issued = new Set<string>();
const mock = createServer((request, response) => {
	let body = "";

	request.on("data", (chunk) => {
		body += chunk;
	}).on("end", () => {
		seen.push({ "method": request.method ?? "", "url": request.url ?? "", "headers": request.headers, "body": body });

		if (request.url === "/login/oauth/access_token") {
			refreshes += 1;

			const next = { "access_token": `ghu_refreshed_${crypto.randomUUID()}`, "refresh_token": `ghr_${crypto.randomUUID()}`, "expires_in": 28800, "refresh_token_expires_in": 15897600 };

			issued.add(next.access_token).add(next.refresh_token);
			// Slow enough that concurrent requests would overlap, were they not held.
			setTimeout(() => response.end(JSON.stringify(refresh === "ok" ? next : { "error": "bad_refresh_token" })), 100);

			return;
		}

		if (request.url?.startsWith("/repos/octo/hello/git/trees/")) {
			response.setHeader("link", `<http://${request.headers.host}/repos/octo/hello/git/trees/main?page=2>; rel="next"`);
		}

		response.setHeader("content-type", request.url?.includes(".git/") ? "application/x-git-upload-pack-advertisement" : "application/json");
		response.setHeader("x-ratelimit-remaining", "4999");
		response.setHeader("set-cookie", "github=secret");
		response.end(request.url?.includes(".git/") ? "001e# service=git-upload-pack\n" : JSON.stringify({ "ok": true, "url": request.url }));
	});
});

await new Promise<void>((resolve) => {
	mock.listen(0, "127.0.0.1", resolve);
});

const githubOrigin = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
const server = createTestHarness({ "root": new URL("..", import.meta.url).pathname, "workers": [{ "configPath": "wrangler.jsonc", secrets, "vars": { "GITHUB_ORIGIN": githubOrigin, "GITHUB_API": githubOrigin } }] });
const worker = server.getWorker();
let base: URL;
let env: { "GRANTS": { "newUniqueId": () => DurableObjectId; "get": (id: DurableObjectId) => { "begin": (options: unknown) => Promise<{ "code": string }> } }; "DB": D1Database; "AUDIT_COPIES": R2Bucket };

before(async () => {
	({ "url": base } = await server.listen());
	await worker.applyD1Migrations("DB");
	env = await worker.getEnv() as typeof env;
});

after(async () => {
	await server.close();
	mock.close();
});

const at = (path: string): string => new URL(path, base).href;

/** A request from an IP of its own (TEST-NET-2), so the functional tests never meet the per-IP rate limits. */
const anyIp = (): string => `198.51.100.${Math.floor(Math.random() * 254) + 1}`;

const fetchFrom = async (url: string, init: { "method"?: string; "headers"?: Record<string, string>; "body"?: string; "redirect"?: "manual" } = {}): Promise<Awaited<ReturnType<typeof server.fetch>>> => server.fetch(url, { ...init, "headers": { "cf-connecting-ip": anyIp(), ...BROWSER, ...init.headers } });

type Answer = Awaited<ReturnType<typeof server.fetch>>;

/** A signed-in browser: a key, a sign-in begun with these GitHub tokens, and its access token redeemed. */
async function signedIn(github: { "accessToken": string; "expiresAt": number }): Promise<{ "call": (method: string, path: string, init?: { "body"?: string; "headers"?: Record<string, string> }) => Promise<Answer>; "accessToken": string; "refreshToken": string; "grantId": string; "proof": (method: string, url: string, claims?: Record<string, unknown>) => Promise<string> }> {
	const { privateKey, publicKey } = await generateKeyPair("ES256");
	const jwk = await exportJWK(publicKey);
	let nonce: string | undefined;
	const proof = async (method: string, url: string, claims: Record<string, unknown> = {}): Promise<string> => new SignJWT({ "htm": method, "htu": url, "jti": crypto.randomUUID(), "iat": Math.floor(Date.now() / 1000), ...nonce === undefined ? {} : { "nonce": nonce }, ...claims }).setProtectedHeader({ "typ": "dpop+jwt", "alg": "ES256", "jwk": jwk }).sign(privateKey);
	const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
	const id = env.GRANTS.newUniqueId();
	const refreshToken = `ghr_${crypto.randomUUID()}`;

	issued.add(github.accessToken).add(refreshToken);

	const { code } = await env.GRANTS.get(id).begin({ "githubId": 7, "github": { ...github, "refreshToken": refreshToken, "refreshExpiresAt": Date.now() + 1e10 }, "codeChallenge": await s256(verifier), "jkt": await calculateJwkThumbprint(jwk), "from": { "country": null, "ipHash": null } });
	const send = async (method: string, path: string, { body, headers = {}, token }: { "body"?: string; "headers"?: Record<string, string>; "token"?: string } = {}): Promise<Answer> => {
		for (let attempt = 0; ; attempt += 1) {
			const ath = token === undefined ? {} : { "ath": await s256(token) };
			const response = await fetchFrom(at(path), { "method": method, "headers": { "dpop": await proof(method, at(path), ath), ...token === undefined ? {} : { "authorization": `DPoP ${token}` }, ...headers }, ...body === undefined ? {} : { "body": body } });

			nonce = response.headers.get("dpop-nonce") ?? nonce;

			if (attempt === 0 && response.headers.has("dpop-nonce") && (response.status === 400 || response.status === 401) && (await response.clone().json() as { "error"?: string }).error === "use_dpop_nonce") {
				continue;
			}

			return response;
		}
	};
	const tokens = await (await send("POST", "/token", { "headers": { "content-type": "application/x-www-form-urlencoded" }, "body": new URLSearchParams({ "grant_type": "authorization_code", "code": code, "code_verifier": verifier, "client_id": "editor" }).toString() })).json() as { "access_token": string; "refresh_token": string };

	return {
		"call": async (method, path, init = {}) => send(method, path, { ...init, "token": tokens.access_token }),
		"accessToken": tokens.access_token,
		"refreshToken": tokens.refresh_token,
		"grantId": id.toString(),
		"proof": proof
	};
}

const fresh = (): { "accessToken": string; "expiresAt": number } => ({ "accessToken": `ghu_${crypto.randomUUID()}`, "expiresAt": Date.now() + 3_600_000 });

const lastTo = (path: string): (typeof seen)[number] | undefined => seen.findLast((request) => request.url.startsWith(path));

test("an allowed API call goes to GitHub with the sign-in's token, and nothing of the browser's", async () => {
	const github = fresh();
	const session = await signedIn(github);
	const response = await session.call("GET", "/github/api/user");
	const upstream = lastTo("/user");

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { "ok": true, "url": "/user" });
	assert.equal(upstream?.headers.authorization, `Bearer ${github.accessToken}`);
	assert.equal(upstream?.headers.dpop, undefined);
	assert.equal(response.headers.get("set-cookie"), null, "GitHub's other headers stay at the proxy");
	assert.equal(response.headers.get("x-ratelimit-remaining"), "4999");
});

test("a query passes through, and pagination links point back at the proxy", async () => {
	const session = await signedIn(fresh());
	const response = await session.call("GET", "/github/api/repos/octo/hello/git/trees/main?recursive=1");

	assert.equal(lastTo("/repos/octo/hello/git/trees/")?.url, "/repos/octo/hello/git/trees/main?recursive=1");
	assert.equal(response.headers.get("link"), `<${base.origin}/github/api/repos/octo/hello/git/trees/main?page=2>; rel="next"`);
});

test("a commit's writes go through: blobs, trees, commits, then moving the ref", async () => {
	const session = await signedIn(fresh());

	for (const [method, path] of [["POST", "/repos/octo/hello/git/blobs"], ["POST", "/repos/octo/hello/git/trees"], ["POST", "/repos/octo/hello/git/commits"], ["PATCH", "/repos/octo/hello/git/refs/heads/main"]] as const) {
		const response = await session.call(method, `/github/api${path}`, { "headers": { "content-type": "application/json" }, "body": "{\"x\":1}" });

		assert.equal(response.status, 200, path);
		assert.equal(lastTo(path)?.body, "{\"x\":1}");
	}
});

test("anything the editor doesn't call is refused, and audited with its method and its path hashed (what was guessed)", async () => {
	const before = seen.length;
	const calls = [["GET", "/github/api/user/emails"], ["GET", "/github/api/repos/octo/hello/collaborators"], ["POST", "/github/api/repos/octo/hello/git/refs/heads/main"], ["GET", "/github/api/repos/octo/hello/git/ref/heads%2F..%2F..%2Fsecret"], ["POST", "/github/git/octo/hello.git/git-receive-pack"], ["GET", "/github/git/octo/hello.git/info/refs?service=git-receive-pack"], ["GET", "/github/git/octo/hello.git/info/refs"]] as const;

	// Two sign-ins, fewer than five refusals each: five in ten minutes end a sign-in (the next test).
	for (const batch of [calls.slice(0, 4), calls.slice(4)]) {
		const session = await signedIn(fresh());

		for (const [method, path] of batch) {
			assert.equal((await session.call(method, path)).status, 403, `${method} ${path}`);
		}

		const details = (await env.DB.prepare("SELECT detail FROM audit WHERE grant_id = ? AND event = 'proxy_denied' ORDER BY id").bind(session.grantId).all<{ "detail": string }>()).results.map((row) => row.detail);

		const expected = await Promise.all(batch.map(async ([method, path]) => {
			const [, base = "", rest = ""] = /^\/github\/(api|git)(.*)$/u.exec(path) ?? [];

			return `${method} /github/${base}/… #${await keyed({ "AUDIT_KEY": secrets.AUDIT_KEY } as Parameters<typeof keyed>[0], "values", rest)}`;
		}));

		assert.deepEqual(details, expected);
	}

	assert.equal(seen.length, before, "none of it reached GitHub");
});

test("a sign-in that keeps asking for what the editor never does is ended", async () => {
	const session = await signedIn(fresh());

	for (let attempt = 1; attempt <= 5; attempt += 1) {
		assert.equal((await session.call("GET", "/github/api/user/emails")).status, 403);
	}

	assert.equal((await session.call("GET", "/github/api/user")).status, 401, "the sign-in is over");

	const events = (await env.DB.prepare("SELECT event, reason FROM audit WHERE grant_id = ? AND event IN ('proxy_abuse', 'grant_revoked') ORDER BY id").bind(session.grantId).all<{ "event": string; "reason": string | null }>()).results;

	assert.deepEqual(events, [{ "event": "proxy_abuse", "reason": "5 refused calls in 10 minutes" }, { "event": "grant_revoked", "reason": null }]);
});

test("a clone's two requests go to github.com with the token as git's password", async () => {
	const github = fresh();
	const session = await signedIn(github);
	const refs = await session.call("GET", "/github/git/octo/hello.git/info/refs?service=git-upload-pack");

	assert.equal(refs.status, 200);
	assert.equal(await refs.text(), "001e# service=git-upload-pack\n");
	assert.equal(lastTo("/octo/hello.git/info/refs")?.headers.authorization, `Basic ${btoa(`x-access-token:${github.accessToken}`)}`);

	const pack = await session.call("POST", "/github/git/octo/hello.git/git-upload-pack", { "headers": { "content-type": "application/x-git-upload-pack-request" }, "body": "0032want 0123456789012345678901234567890123456789\n00000009done\n" });

	assert.equal(pack.status, 200);
	assert.match(lastTo("/octo/hello.git/git-upload-pack")?.body ?? "", /^0032want/u);
});

test("signed out, there's no proxy", async () => {
	assert.equal((await fetchFrom(at("/github/api/user"))).status, 401);
	assert.equal((await fetchFrom(at("/github/git/octo/hello.git/info/refs?service=git-upload-pack"))).status, 401);
});

test("GitHub's token is refreshed once it's close to expiring — once, however many requests arrive together", async () => {
	const session = await signedIn({ "accessToken": `ghu_${crypto.randomUUID()}`, "expiresAt": Date.now() + 60_000 });
	const before = refreshes;
	const responses = await Promise.all([1, 2, 3, 4].map(async () => session.call("GET", "/github/api/user")));

	assert.deepEqual(responses.map((response) => response.status), [200, 200, 200, 200]);
	assert.equal(refreshes - before, 1);
	assert.match(lastTo("/user")?.headers.authorization ?? "", /^Bearer ghu_refreshed_/u);
	assert.equal(new URLSearchParams(lastTo("/login/oauth/access_token")?.body).get("grant_type"), "refresh_token");
});

test("a refresh GitHub refuses ends the sign-in", async () => {
	const session = await signedIn({ "accessToken": `ghu_${crypto.randomUUID()}`, "expiresAt": Date.now() + 60_000 });

	refresh = "refused";

	try {
		assert.equal((await session.call("GET", "/github/api/user")).status, 401);
		assert.equal((await session.call("GET", "/me")).status, 401);

		const events = (await env.DB.prepare("SELECT event FROM audit WHERE grant_id = ? ORDER BY id").bind(session.grantId).all<{ "event": string }>()).results.map((row) => row.event);

		assert.deepEqual(events.slice(-3), ["github_refresh_refused", "grant_revoked", "auth_refused"]);
	} finally {
		refresh = "ok";
	}
});

test("signing out revokes GitHub's token at GitHub too", async () => {
	const github = fresh();
	const session = await signedIn(github);

	await session.call("POST", "/revoke", { "headers": { "content-type": "application/x-www-form-urlencoded" }, "body": new URLSearchParams({ "token": session.refreshToken }).toString() });

	const deleted = lastTo("/applications/");

	assert.equal(deleted?.method, "DELETE");
	assert.equal(deleted?.url, "/applications/Iv23ligdisoL7OPTVtXm/token");
	assert.equal(deleted?.headers.authorization, `Basic ${btoa(`Iv23ligdisoL7OPTVtXm:${secrets.GITHUB_CLIENT_SECRET}`)}`);
	assert.deepEqual(JSON.parse(deleted?.body ?? "{}"), { "access_token": github.accessToken });
});

test("sizes: an oversized form, clone request or proof header is refused before it's read", async () => {
	const session = await signedIn(fresh());

	assert.equal((await fetchFrom(at("/token"), { "method": "POST", "headers": { "content-type": "application/x-www-form-urlencoded" }, "body": `grant_type=refresh_token&refresh_token=${"x".repeat(8 * 1024)}` })).status, 413);
	assert.equal((await session.call("POST", "/github/git/octo/hello.git/git-upload-pack", { "headers": { "content-type": "application/x-git-upload-pack-request" }, "body": "0".repeat(2 * 1024 * 1024) })).status, 413);
	assert.equal((await fetchFrom(at("/me"), { "headers": { "authorization": `DPoP ${session.accessToken}`, "dpop": "x".repeat(9 * 1024) } })).status, 431);
});

test("no GitHub token or client secret reaches the logs", async () => {
	const logs = JSON.stringify(server.getLogs());

	assert.ok(issued.size > 10);
	assert.deepEqual([...issued, secrets.GITHUB_CLIENT_SECRET].filter((value) => logs.includes(value)), []);
});

/** D1's audit rows, and the bucket's copies as `npm run audit -- --verify` reads them. */
async function ledger(): Promise<{ "rows": Row[]; "copies": Map<number, Copy> }> {
	const rows = (await env.DB.prepare("SELECT id, at, event, user_id, grant_id, country, ip_hash, reason, detail, trace_id FROM audit ORDER BY id").all<Row>()).results;
	const copies = new Map<number, Copy>();

	for (const { key } of (await env.AUDIT_COPIES.list({ "limit": 1000 })).objects) {
		const parsed = parseKey(key);
		const body = await (await env.AUDIT_COPIES.get(key))?.json() as Row;

		if (parsed !== undefined) {
			const entry = copies.get(parsed.id) ?? { "row": body };

			if (parsed.finished) {
				entry.finished = body.reason ?? undefined;
			} else {
				entry.row = body;
			}

			copies.set(parsed.id, entry);
		}
	}

	return { "rows": rows, "copies": copies };
}

test("every audit row has its write-once copy, the same; a proxied call's copy has its bytes", async () => {
	const { rows, copies } = await ledger();
	const verdict = compare(rows, copies);

	assert.ok(rows.length > 20, "the run wrote rows");
	assert.deepEqual(verdict.findings, []);
	assert.equal(verdict.matching, rows.length);
	assert.ok([...copies.values()].some((copy) => copy.row.event === "proxy_call" && /bytes$/u.test(copy.finished ?? "")), "a call's bytes are in its .finished part");

	// The Worker's own binding can't replace a copy: `if-none-match: *` refuses an existing key.
	const first = rows[0] as Row;

	assert.equal(await env.AUDIT_COPIES.put(copyKey(first.event, first.id), "{}", { "onlyIf": new Headers({ "if-none-match": "*" }) }), null);
	assert.equal((await (await env.AUDIT_COPIES.get(copyKey(first.event, first.id)))?.json() as Row).id, first.id);
});

test("verifying finds a row edited, a row deleted, and a row that was never copied", async () => {
	const { rows } = await ledger();
	const [edited, deleted] = rows as [Row, Row];

	await env.DB.batch([
		env.DB.prepare("UPDATE audit SET detail = 'nothing to see' WHERE id = ?").bind(edited.id),
		env.DB.prepare("DELETE FROM audit WHERE id = ?").bind(deleted.id),
		env.DB.prepare("INSERT INTO audit (at, event, reason) VALUES (?, 'proxy_denied', 'written around the Worker')").bind(Date.now())
	]);

	const found = compare(...Object.values(await ledger()) as [Row[], Map<number, Copy>]).findings.map((finding) => `${finding.kind} ${finding.id}`);
	const last = (await env.DB.prepare("SELECT MAX(id) AS id FROM audit").first<{ "id": number }>())?.id;

	assert.deepEqual(found, [`edited ${edited.id}`, `deleted ${deleted.id}`, `not copied ${last}`].sort((a, b) => Number(a.split(" ").pop()) - Number(b.split(" ").pop())));
});


test("the Worker never replaces a copy: one already at its next id stays as it was", async () => {
	const next = ((await env.DB.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'audit'").first<{ "seq": number }>())?.seq ?? 0) + 1;
	const planted = copyKey("auth_refused", next);

	await env.AUDIT_COPIES.put(planted, JSON.stringify({ "planted": true }));
	await fetchFrom(at("/me"), { "headers": { "authorization": "DPoP not-a-token" } });

	const written = await env.DB.prepare("SELECT id, event FROM audit WHERE id = ?").bind(next).first<{ "id": number; "event": string }>();

	assert.equal(written?.event, "auth_refused", "the refusal took that id");
	assert.deepEqual(await (await env.AUDIT_COPIES.get(planted))?.json(), { "planted": true });
});
