import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { base64url, calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTestHarness } from "wrangler";

// Detecting abuse (README.md, "Hardening"): the rate limits, the alert someone gets at once when a sign-in is used the
// way only a thief or a script would use it (deduplicated, and never quoting a secret), and every proxied write recorded.

const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "test" };

/** GitHub and the alert webhook, both: alerts kept, GitHub answering whatever it's asked. */
const alerts: { "headers": Record<string, unknown>; "body": string }[] = [];
const mock = createServer((request, response) => {
	let body = "";

	request.on("data", (chunk) => {
		body += chunk;
	}).on("end", () => {
		if (request.url === "/alerts") {
			alerts.push({ "headers": request.headers, "body": body });
		}

		response.setHeader("content-type", "application/json");
		response.end("{\"ok\":true}");
	});
});

await new Promise<void>((resolve) => {
	mock.listen(0, "127.0.0.1", resolve);
});

const origin = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
const secrets = {
	"SIGNING_JWK": JSON.stringify(signing),
	"NONCE_KEY": "nonce key for the tests",
	"TOKEN_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"AUDIT_KEY": "audit key for the tests",
	"STATE_KEY": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"GITHUB_CLIENT_SECRET": "client secret for the tests",
	"ALERT_WEBHOOK": `${origin}/alerts`
};
const server = createTestHarness({ "root": new URL("..", import.meta.url).pathname, "workers": [{ "configPath": "wrangler.jsonc", secrets, "vars": { "GITHUB_ORIGIN": origin, "GITHUB_API": origin } }] });
const worker = server.getWorker();
let base: URL;
let env: { "GRANTS": { "newUniqueId": () => DurableObjectId; "get": (id: DurableObjectId) => { "begin": (options: unknown) => Promise<{ "code": string }> } }; "DB": D1Database };

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

type Answer = Awaited<ReturnType<typeof server.fetch>>;

const from = (ip: string, init: { "method"?: string; "headers"?: Record<string, string>; "body"?: string; "redirect"?: "manual" } = {}): Parameters<typeof server.fetch>[1] => ({ ...init, "headers": { "cf-connecting-ip": ip, ...init.headers } });

/** A DPoP key, and requests signed with it (a nonce asked for, retried). */
async function key(): Promise<{ "jkt": string; "send": (method: string, path: string, init?: { "token"?: string; "form"?: Record<string, string>; "body"?: string }) => Promise<Answer> }> {
	const { privateKey, publicKey } = await generateKeyPair("ES256");
	const jwk = await exportJWK(publicKey);
	let nonce: string | undefined;

	return {
		"jkt": await calculateJwkThumbprint(jwk),
		"send": async (method, path, { token, form, body } = {}) => {
			for (let attempt = 0; ; attempt += 1) {
				const claims = { "htm": method, "htu": at(path), "jti": crypto.randomUUID(), "iat": Math.floor(Date.now() / 1000), ...nonce === undefined ? {} : { "nonce": nonce }, ...token === undefined ? {} : { "ath": base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)))) } };
				const proof = await new SignJWT(claims).setProtectedHeader({ "typ": "dpop+jwt", "alg": "ES256", "jwk": jwk }).sign(privateKey);
				const headers: Record<string, string> = { "dpop": proof, "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 254) + 1}`, ...token === undefined ? {} : { "authorization": `DPoP ${token}` }, ...form === undefined ? {} : { "content-type": "application/x-www-form-urlencoded" } };
				const response = await server.fetch(at(path), { "method": method, "headers": headers, ...form === undefined ? body === undefined ? {} : { "body": body } : { "body": new URLSearchParams(form).toString() } });

				nonce = response.headers.get("dpop-nonce") ?? nonce;

				if (attempt === 0 && response.headers.has("dpop-nonce") && (response.status === 400 || response.status === 401) && (await response.clone().json() as { "error"?: string }).error === "use_dpop_nonce") {
					continue;
				}

				return response;
			}
		}
	};
}

/** A sign-in (as GitHub's callback starts one) redeemed by `holder`: its tokens and grant. */
async function signedIn(holder: Awaited<ReturnType<typeof key>>): Promise<{ "accessToken": string; "refreshToken": string; "grantId": string }> {
	const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
	const id = env.GRANTS.newUniqueId();
	const { code } = await env.GRANTS.get(id).begin({ "githubId": Math.floor(Math.random() * 1e9), "github": { "accessToken": "ghu_test", "refreshToken": "ghr_test", "expiresAt": Date.now() + 3_600_000, "refreshExpiresAt": Date.now() + 1e10 }, "codeChallenge": base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))), "jkt": holder.jkt, "from": { "country": null, "ipHash": null, "traceId": null } });
	const tokens = await (await holder.send("POST", "/token", { "form": { "grant_type": "authorization_code", "code": code, "code_verifier": verifier, "client_id": "editor" } })).json() as { "access_token": string; "refresh_token": string };

	return { "accessToken": tokens.access_token, "refreshToken": tokens.refresh_token, "grantId": id.toString() };
}

async function rows(event: string): Promise<{ "reason": string | null; "detail": string | null; "trace_id": string | null; "ip_hash": string | null }[]> {
	return (await env.DB.prepare("SELECT reason, detail, trace_id, ip_hash FROM audit WHERE event = ? ORDER BY id").bind(event).all<{ "reason": string | null; "detail": string | null; "trace_id": string | null; "ip_hash": string | null }>()).results;
}

test("sign-in is limited per IP: 20 a minute, then a 429 that's recorded — and another IP is unaffected", async () => {
	const start = `${at("/auth/github/start")}?client_id=editor`;

	for (let attempt = 1; attempt <= 20; attempt += 1) {
		assert.equal((await server.fetch(start, from("203.0.113.20", { "redirect": "manual" }))).status, 400, `attempt ${attempt}`);
	}

	const limited = await server.fetch(start, from("203.0.113.20", { "redirect": "manual" }));

	assert.equal(limited.status, 429);
	assert.equal(limited.headers.get("retry-after"), "60");
	assert.equal((await server.fetch(start, from("203.0.113.21", { "redirect": "manual" }))).status, 400, "another IP");

	const [recorded] = await rows("rate_limited");

	assert.equal(recorded?.reason, "SIGN_IN_BY_IP");
	assert.equal(recorded?.detail, "GET /auth/github/start");
	assert.match(recorded?.ip_hash ?? "", /^[\w-]{22}$/u);
	assert.match(recorded?.trace_id ?? "", /^[0-9a-f]{32}$/u);
});

test("the token endpoint is limited per grant, whatever IPs the requests come from", async () => {
	const grant = `${env.GRANTS.newUniqueId().toString()}.secret`;
	const statuses: number[] = [];

	for (let attempt = 1; attempt <= 11; attempt += 1) {
		statuses.push((await server.fetch(at("/token"), from(`203.0.113.${100 + attempt}`, { "method": "POST", "headers": { "content-type": "application/x-www-form-urlencoded" }, "body": new URLSearchParams({ "grant_type": "refresh_token", "refresh_token": grant, "client_id": "editor" }).toString() }))).status);
	}

	assert.deepEqual(statuses, [...Array.from({ "length": 10 }, () => 400), 429]);
	assert.equal((await rows("rate_limited")).some((row) => row.reason === "TOKEN_BY_GRANT"), true);
});

test("a stolen access token, used with another key, alerts at once — once a minute, and without the token", async () => {
	const owner = await key();
	const { accessToken, grantId } = await signedIn(owner);
	const thief = await key();
	const before = alerts.length;

	assert.equal((await thief.send("GET", "/me", { "token": accessToken })).status, 401);
	assert.equal((await thief.send("GET", "/me", { "token": accessToken })).status, 401);

	const sent = alerts.slice(before);

	assert.equal(sent.length, 1, "the second, within the minute, is in the audit log but not another alert");
	assert.match(sent[0]?.body ?? "", /^\[editor-api local\] auth_refused: key is not the one bound\nGET \/me\n/u);
	assert.match(sent[0]?.body ?? "", new RegExp(`grant ${grantId.slice(0, 12)}…`, "u"));
	assert.match(sent[0]?.body ?? "", /\ntrace [0-9a-f]{32}$/u);
	assert.equal(sent[0]?.body.includes(accessToken), false);
	assert.equal(sent[0]?.headers["priority"], "high");
	assert.equal((await rows("auth_refused")).filter((row) => row.reason === "key is not the one bound").length, 2, "both recorded");

	// The owner is unaffected.
	assert.equal((await owner.send("GET", "/me", { "token": accessToken })).status, 200);
});

test("a stolen refresh token, used with another key, alerts too", async () => {
	const owner = await key();
	const { refreshToken } = await signedIn(owner);
	const before = alerts.length;

	assert.equal((await (await key()).send("POST", "/token", { "form": { "grant_type": "refresh_token", "refresh_token": refreshToken, "client_id": "editor" } })).status, 400);
	assert.match(alerts.slice(before)[0]?.body ?? "", /^\[editor-api local\] token_rejected: another key/u);
});

test("every write through the proxy is recorded, with what it was and GitHub's answer", async () => {
	const holder = await key();
	const { accessToken, grantId } = await signedIn(holder);

	await holder.send("POST", "/github/api/repos/octo/hello/git/blobs", { "token": accessToken, "body": "{}" });
	await holder.send("GET", "/github/api/repos/octo/hello", { "token": accessToken });

	const writes = (await env.DB.prepare("SELECT detail, reason FROM audit WHERE grant_id = ? AND event = 'proxy_write'").bind(grantId).all<{ "detail": string; "reason": string }>()).results;

	assert.deepEqual(writes, [{ "detail": "POST /repos/octo/hello/git/blobs", "reason": "GitHub 200" }], "the write, not the read");
});

test("the proxy is limited per user: 300 a minute", async () => {
	const holder = await key();
	const { accessToken } = await signedIn(holder);
	const statuses = await Promise.all(Array.from({ "length": 301 }, async () => (await holder.send("GET", "/github/api/user", { "token": accessToken })).status));

	assert.equal(statuses.filter((status) => status === 200).length, 300);
	assert.equal(statuses.filter((status) => status === 429).length, 1);
});

test("refusals at the token endpoint, and oversized requests, are recorded with why", async () => {
	const unknown = `${env.GRANTS.newUniqueId().toString()}.secret`;
	const owner = await key();
	const { refreshToken, grantId } = await signedIn(owner);

	await server.fetch(at("/token"), from("203.0.113.50", { "method": "POST", "headers": { "content-type": "application/x-www-form-urlencoded" }, "body": new URLSearchParams({ "grant_type": "refresh_token", "refresh_token": unknown, "client_id": "editor" }).toString() }));
	await server.fetch(at("/token"), from("203.0.113.51", { "method": "POST", "headers": { "content-type": "application/x-www-form-urlencoded" }, "body": new URLSearchParams({ "grant_type": "refresh_token", "refresh_token": refreshToken, "client_id": "editor" }).toString() }));
	await server.fetch(at("/me"), from("203.0.113.52", { "headers": { "authorization": "DPoP x", "dpop": "x".repeat(9 * 1024) } }));
	await server.fetch(at("/token"), from("203.0.113.53", { "method": "POST", "headers": { "content-type": "application/x-www-form-urlencoded" }, "body": "x".repeat(8 * 1024) }));

	const refused = (await rows("auth_refused")).filter((row) => row.detail === "POST /token").map((row) => row.reason);

	assert.deepEqual(refused.slice(-2), ["no such grant", "missing, or more than one"], "an unknown grant, then a refresh with no proof");
	assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit WHERE grant_id = ? AND event = 'auth_refused'").bind(grantId).first<{ "n": number }>())?.n, 1, "the second names its grant");
	assert.deepEqual((await rows("oversized")).map((row) => [row.reason, row.detail]), [["header too large", "GET /me"], ["body too large", "POST /token"]]);
});
