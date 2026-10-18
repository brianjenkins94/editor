import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { base64url, calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTestHarness } from "wrangler";

// C1 in workerd (SIGN-IN.md): the admin app pushes its request (PAR, with DPoP and our nonce), the browser opens the
// attempt (its cookie) and reaches our sign-in page, chooses GitHub, and GitHub's callback finishes the attempt in that
// same browser with a code the app redeems. Against a GitHub of the test's own.

const OWNER = 9398474;
const APP = "http://localhost:5174/";
const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "test" };
const secrets = {
	"SIGNING_JWK": JSON.stringify(signing),
	"NONCE_KEY": "nonce key for the tests",
	"TOKEN_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"AUDIT_KEY": "audit key for the tests",
	"STATE_KEY": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"GITHUB_CLIENT_SECRET": "client secret for the tests"
};
const mock = createServer((request, response) => {
	request.resume().on("end", () => {
		response.setHeader("content-type", "application/json");
		response.end(request.url === "/login/oauth/access_token"
			? JSON.stringify({ "access_token": `ghu_${crypto.randomUUID()}`, "refresh_token": `ghr_${crypto.randomUUID()}`, "expires_in": 28800, "refresh_token_expires_in": 15897600 })
			: request.url === "/user" ? JSON.stringify({ "id": OWNER, "login": "brianjenkins94" }) : "{}");
	});
});

await new Promise<void>((resolve) => {
	mock.listen(0, "127.0.0.1", resolve);
});

const githubOrigin = `http://127.0.0.1:${(mock.address() as AddressInfo).port}`;
const server = createTestHarness({ "root": new URL("..", import.meta.url).pathname, "workers": [{ "configPath": "wrangler.jsonc", secrets, "vars": { "GITHUB_ORIGIN": githubOrigin, "GITHUB_API": githubOrigin } }] });
const worker = server.getWorker();
let base: URL;

before(async () => {
	({ "url": base } = await server.listen());
	await worker.applyD1Migrations("DB");
});

after(async () => {
	await server.close();
	mock.close();
});

const at = (path: string): string => new URL(path, base).href;

type Answer = Awaited<ReturnType<typeof server.fetch>>;

/** A request from a browser at an IP of its own, with that browser's cookie when it has one. */
const browse = async (url: string, { cookie, ...init }: { "method"?: string; "headers"?: Record<string, string>; "body"?: string; "cookie"?: string } = {}): Promise<Answer> => server.fetch(url, { ...init, "redirect": "manual", "headers": { "cf-connecting-ip": `198.51.100.${Math.floor(Math.random() * 254) + 1}`, ...cookie === undefined ? {} : { "cookie": cookie }, ...init.headers } });

/** The admin app: a DPoP key, a PKCE verifier, a state, and the nonce it last got. */
async function app(): Promise<{ "jkt": string; "verifier": string; "challenge": string; "state": string; "nonce"?: string; "proof": (method: string, url: string) => Promise<string> }> {
	const { privateKey, publicKey } = await generateKeyPair("ES256");
	const jwk = await exportJWK(publicKey);
	const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
	const client = {
		"jkt": await calculateJwkThumbprint(jwk),
		"verifier": verifier,
		"challenge": base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))),
		"state": crypto.randomUUID(),
		"nonce": undefined as string | undefined,
		"proof": async (method: string, url: string) => new SignJWT({ "htm": method, "htu": url, "jti": crypto.randomUUID(), "iat": Math.floor(Date.now() / 1000), ...client.nonce === undefined ? {} : { "nonce": client.nonce } }).setProtectedHeader({ "typ": "dpop+jwt", "alg": "ES256", "jwk": jwk }).sign(privateKey)
	};

	return client;
}

type App = Awaited<ReturnType<typeof app>>;

/** A form POST with a DPoP proof, retried once with the nonce we ask for (as oauth4webapi does). */
async function post(client: App, path: string, form: Record<string, string>): Promise<Answer> {
	for (let attempt = 0; ; attempt += 1) {
		const response = await browse(at(path), { "method": "POST", "headers": { "content-type": "application/x-www-form-urlencoded", "dpop": await client.proof("POST", at(path)) }, "body": new URLSearchParams(form).toString() });

		client.nonce = response.headers.get("dpop-nonce") ?? client.nonce;

		if (attempt === 0 && response.status === 400 && (await response.clone().json() as { "error"?: string }).error === "use_dpop_nonce") {
			continue;
		}

		return response;
	}
}

const pushed = (client: App, overrides: Record<string, string> = {}): Promise<Answer> => post(client, "/auth/par", { "client_id": "admin", "response_type": "code", "redirect_uri": APP, "state": client.state, "code_challenge": client.challenge, "code_challenge_method": "S256", ...overrides });

/** Push, then open in a browser: the attempt's cookie. */
async function opened(client: App): Promise<{ "cookie": string; "requestUri": string }> {
	const { request_uri } = await (await pushed(client)).json() as { "request_uri": string };
	const started = await browse(`${at("/auth/start")}?${new URLSearchParams({ "client_id": "admin", "request_uri": request_uri })}`);

	assert.equal(started.status, 302);
	assert.equal(started.headers.get("location"), "/sign-in");

	return { "cookie": (started.headers.get("set-cookie") ?? "").split(";")[0] as string, "requestUri": request_uri };
}

async function refusals(): Promise<string[]> {
	const env = await worker.getEnv() as { "DB": D1Database };

	return (await env.DB.prepare("SELECT reason FROM audit WHERE event = 'sign_in_refused' ORDER BY id").all<{ "reason": string }>()).results.map((row) => row.reason);
}

test("PAR: the request is pushed with a DPoP proof and our nonce, and comes back as a request_uri", async () => {
	const client = await app();
	const first = await browse(at("/auth/par"), { "method": "POST", "headers": { "content-type": "application/x-www-form-urlencoded", "dpop": await client.proof("POST", at("/auth/par")) }, "body": new URLSearchParams({ "client_id": "admin", "response_type": "code", "redirect_uri": APP, "state": client.state, "code_challenge": client.challenge, "code_challenge_method": "S256" }).toString() });

	assert.equal(first.status, 400, "no nonce yet");
	assert.ok(first.headers.get("dpop-nonce"));

	const response = await pushed(client);
	const body = await response.json() as { "request_uri": string; "expires_in": number };

	assert.equal(response.status, 201);
	assert.match(body.request_uri, /^urn:ietf:params:oauth:request_uri:[0-9a-f]{64}$/u);
	assert.equal(body.expires_in, 120);
});

test("PAR refuses what /auth/github/start refuses, and a push without a proof", async () => {
	const client = await app();
	const before = (await refusals()).length;

	assert.equal((await pushed(client, { "client_id": "someone-else" })).status, 400);
	assert.equal((await pushed(client, { "redirect_uri": "http://localhost:5173/" })).status, 400, "the editor's page");
	assert.equal((await pushed(client, { "code_challenge_method": "plain" })).status, 400);
	assert.equal((await browse(at("/auth/par"), { "method": "POST", "headers": { "content-type": "application/x-www-form-urlencoded" }, "body": new URLSearchParams({ "client_id": "admin", "response_type": "code", "redirect_uri": APP, "state": "s", "code_challenge": client.challenge, "code_challenge_method": "S256" }).toString() })).status, 400);
	assert.deepEqual((await refusals()).slice(before), ["client_id or response_type", "redirect_uri not registered", "PKCE or state", "missing, or more than one"]);
});

test("/auth/start opens the attempt once, in this browser: a __Host- cookie, then the sign-in page", async () => {
	const client = await app();
	const { request_uri } = await (await pushed(client)).json() as { "request_uri": string };
	const open = async (clientId = "admin"): Promise<Answer> => browse(`${at("/auth/start")}?${new URLSearchParams({ "client_id": clientId, "request_uri": request_uri })}`);

	assert.equal((await open("editor")).status, 400, "another client's request");

	const started = await open();
	const cookie = started.headers.get("set-cookie") ?? "";

	assert.equal(started.status, 302);
	assert.match(cookie, /^__Host-signin=[0-9a-f]{64}\.[\w-]{43}; Max-Age=900; Path=\/; HttpOnly; Secure; SameSite=Lax$/u);
	assert.equal((await open()).status, 400, "used once");
});

test("a pushed request not opened within two minutes has expired", async () => {
	const client = await app();
	const { request_uri } = await (await pushed(client)).json() as { "request_uri": string };
	const storage = await worker.getDurableObjectStorage("ATTEMPTS", { "id": request_uri.split(":").pop() as string });

	await storage.exec("UPDATE attempt SET pushed_at = ?", Date.now() - 121_000);

	assert.equal((await browse(`${at("/auth/start")}?${new URLSearchParams({ "client_id": "admin", "request_uri": request_uri })}`)).status, 400);
	assert.equal((await refusals()).at(-1), "request_uri expired");
});

test("the sign-in page: our own files only, and what this attempt may use", async () => {
	const client = await app();
	const { cookie } = await opened(client);
	const page = await browse(at("/sign-in"));

	assert.equal(page.status, 200);
	assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'self'.*frame-ancestors 'none'/u);
	assert.deepEqual(await (await browse(at("/auth/attempt"), { "cookie": cookie })).json(), { "client": "admin", "methods": ["github", "password", "passkey"] });
	assert.match((await browse(at("/passkey"))).headers.get("content-security-policy") ?? "", /script-src 'self'.*frame-ancestors 'none'/u, "the passkey page too");
	assert.equal((await browse(at("/auth/attempt"))).status, 401, "another browser has none");
	assert.equal((await browse(at("/auth/attempt"), { "cookie": `${cookie.split(".")[0]}.${"A".repeat(43)}` })).status, 401, "the attempt's id without its secret");
});

test("signing in with GitHub through an attempt: a code for the admin app, redeemed with its key, the owner's", async () => {
	const client = await app();
	const { cookie } = await opened(client);
	const toGitHub = await browse(at("/auth/github"), { "cookie": cookie });
	const state = new URL(toGitHub.headers.get("location") as string).searchParams.get("state") as string;
	const callback = `${at("/auth/github/callback")}?${new URLSearchParams({ "code": "github-code", "state": state })}`;

	assert.equal((await browse(callback)).status, 400, "another browser can't finish it");

	const returned = await browse(callback, { "cookie": cookie });
	const landing = new URL(returned.headers.get("location") as string);

	assert.equal(`${landing.origin}${landing.pathname}`, APP);
	assert.equal(landing.searchParams.get("state"), client.state);
	assert.equal(landing.searchParams.get("iss"), base.origin);
	assert.match(returned.headers.get("set-cookie") ?? "", /^__Host-signin=; Max-Age=0/u, "the cookie goes");

	const tokens = await post(client, "/token", { "grant_type": "authorization_code", "code": landing.searchParams.get("code") as string, "code_verifier": client.verifier, "client_id": "admin" });

	assert.equal(tokens.status, 200);
	assert.equal((await browse(callback, { "cookie": cookie })).status, 400, "the attempt is spent");
	assert.deepEqual((await refusals()).slice(-2), ["another browser", "attempt already finished"]);
});

test("a client whose page doesn't offer GitHub can't be sent there", async () => {
	assert.equal((await browse(at("/auth/github"))).status, 401, "no attempt");
});
