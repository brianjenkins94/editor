import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { base64url, calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTestHarness } from "wrangler";
import { seal } from "@brianjenkins94/util/auth/seal";

// Signing in through GitHub, in workerd, against a GitHub of the test's own: /auth/github/start, GitHub's authorize page
// (skipped: the test is the user saying yes), /auth/github/callback, then the app redeeming our code at /token.

const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "test" };
const secrets = {
	"SIGNING_JWK": JSON.stringify(signing),
	"NONCE_KEY": "nonce key for the tests",
	"TOKEN_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"AUDIT_KEY": "audit key for the tests",
	"STATE_KEY": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"GITHUB_CLIENT_SECRET": `client-secret-${crypto.randomUUID()}`
};
const APP = "http://localhost:5173/";

// GitHub: the token exchange and /user, answering as `github.next` says, and keeping what it was sent.
const github = {
	"exchanges": [] as URLSearchParams[],
	"userAuthorizations": [] as string[],
	"next": { "exchange": "ok" as "ok" | "refused", "id": 4242 as unknown },
	"issued": new Set<string>()
};
const mock = createServer((request, response) => {
	let body = "";

	request.on("data", (chunk) => {
		body += chunk;
	}).on("end", () => {
		response.setHeader("content-type", "application/json");

		if (request.url === "/login/oauth/access_token") {
			github.exchanges.push(new URLSearchParams(body));

			const token = { "access_token": `ghu_${crypto.randomUUID()}`, "refresh_token": `ghr_${crypto.randomUUID()}`, "expires_in": 28800, "refresh_token_expires_in": 15897600, "token_type": "bearer" };

			github.issued.add(token.access_token).add(token.refresh_token);
			response.end(JSON.stringify(github.next.exchange === "ok" ? token : { "error": "bad_verification_code" }));
		} else if (request.url === "/user") {
			github.userAuthorizations.push(request.headers.authorization ?? "");
			response.end(JSON.stringify({ "id": github.next.id, "login": "octocat", "email": "octocat@example.com" }));
		} else {
			response.statusCode = 404;
			response.end("{}");
		}
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

/** A request from an IP of its own (TEST-NET-2), so the functional tests never meet the per-IP rate limits. */
const anyIp = (): string => `198.51.100.${Math.floor(Math.random() * 254) + 1}`;

const fetchFrom = async (url: string, init: { "method"?: string; "headers"?: Record<string, string>; "body"?: string; "redirect"?: "manual" } = {}): Promise<Awaited<ReturnType<typeof server.fetch>>> => server.fetch(url, { ...init, "headers": { "cf-connecting-ip": anyIp(), ...init.headers } });

/** The app: a DPoP key, a PKCE verifier, and a state of its own, as oauth4webapi makes them. */
async function app(): Promise<{ "jkt": string; "verifier": string; "challenge": string; "state": string; "proof": (method: string, url: string, claims?: Record<string, unknown>) => Promise<string> }> {
	const { privateKey, publicKey } = await generateKeyPair("ES256");
	const jwk = await exportJWK(publicKey);
	const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));

	return {
		"jkt": await calculateJwkThumbprint(jwk),
		"verifier": verifier,
		"challenge": base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)))),
		"state": crypto.randomUUID(),
		"proof": async (method, url, claims = {}) => new SignJWT({ "htm": method, "htu": url, "jti": crypto.randomUUID(), "iat": Math.floor(Date.now() / 1000), ...claims }).setProtectedHeader({ "typ": "dpop+jwt", "alg": "ES256", "jwk": jwk }).sign(privateKey)
	};
}

type App = Awaited<ReturnType<typeof app>>;

function startUrl(client: App, overrides: Record<string, string> = {}): string {
	return `${at("/auth/github/start")}?${new URLSearchParams({ "client_id": "editor", "response_type": "code", "redirect_uri": APP, "state": client.state, "code_challenge": client.challenge, "code_challenge_method": "S256", "dpop_jkt": client.jkt, ...overrides })}`;
}

/** /auth/github/start → GitHub's authorize URL (the user says yes) → our callback with GitHub's code → the app's page. */
async function signIn(client: App): Promise<{ "authorize": URL; "landing": URL }> {
	const started = await fetchFrom(startUrl(client), { "redirect": "manual" });
	const authorize = new URL(started.headers.get("location") as string);
	const returned = await fetchFrom(`${at("/auth/github/callback")}?${new URLSearchParams({ "code": `github-code-${crypto.randomUUID()}`, "state": authorize.searchParams.get("state") as string })}`, { "redirect": "manual" });

	assert.equal(returned.status, 302);

	return { "authorize": authorize, "landing": new URL(returned.headers.get("location") as string) };
}

/** The app redeeming our code at /token with its verifier and a proof from its key (one nonce round trip). */
async function redeem(client: App, code: string): Promise<{ "status": number; "body": Record<string, string> }> {
	let nonce: string | undefined;

	for (;;) {
		const response = await fetchFrom(at("/token"), { "method": "POST", "headers": { "content-type": "application/x-www-form-urlencoded", "dpop": await client.proof("POST", at("/token"), nonce === undefined ? {} : { "nonce": nonce }) }, "body": new URLSearchParams({ "grant_type": "authorization_code", "code": code, "code_verifier": client.verifier, "client_id": "editor" }).toString() });
		const body = await response.json() as Record<string, string>;

		if (body["error"] === "use_dpop_nonce" && nonce === undefined) {
			nonce = response.headers.get("dpop-nonce") ?? undefined;
			continue;
		}

		return { "status": response.status, "body": body };
	}
}

test("start sends the browser to GitHub with our own PKCE, and the app's state sealed", async () => {
	const client = await app();
	const response = await fetchFrom(startUrl(client), { "redirect": "manual" });
	const authorize = new URL(response.headers.get("location") as string);

	assert.equal(response.status, 302);
	assert.equal(`${authorize.origin}${authorize.pathname}`, `${githubOrigin}/login/oauth/authorize`);
	assert.equal(authorize.searchParams.get("client_id"), "Iv23ligdisoL7OPTVtXm");
	assert.equal(authorize.searchParams.get("redirect_uri"), at("/auth/github/callback"));
	assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
	assert.notEqual(authorize.searchParams.get("code_challenge"), client.challenge, "GitHub gets a challenge of ours, not the app's");

	const sealed = authorize.searchParams.get("state") ?? "";

	assert.match(sealed, /^v1\./u);
	assert.equal([client.state, client.jkt, client.challenge, APP].some((value) => sealed.includes(value)), false, "nothing readable in it");
});

test("start refuses an unregistered redirect_uri, without redirecting anywhere", async () => {
	const client = await app();

	for (const redirect of ["https://evil.example.com/", "http://localhost:5173/elsewhere", "http://localhost:5173", "https://brianjenkins94.github.io/editor/"]) {
		const response = await fetchFrom(startUrl(client, { "redirect_uri": redirect }), { "redirect": "manual" });

		assert.equal(response.status, 400, redirect);
		assert.equal(response.headers.get("location"), null);
	}
});

test("start refuses without S256 PKCE, a thumbprint, a state, or our client id", async () => {
	const client = await app();

	for (const overrides of [{ "code_challenge_method": "plain" }, { "code_challenge": "short" }, { "dpop_jkt": "" }, { "state": "" }, { "client_id": "someone-else" }, { "response_type": "token" }]) {
		assert.equal((await fetchFrom(startUrl(client, overrides), { "redirect": "manual" })).status, 400, JSON.stringify(overrides));
	}
});

test("a sign-in end to end: GitHub's code exchanged with our secret and verifier, then our code to the app, redeemed", async () => {
	const client = await app();
	const before = github.exchanges.length;
	const { authorize, landing } = await signIn(client);
	const exchange = github.exchanges[before] as URLSearchParams;

	// What GitHub was sent: our client and secret, its code, our callback, and the verifier for the challenge it saw.
	assert.equal(exchange.get("client_id"), "Iv23ligdisoL7OPTVtXm");
	assert.equal(exchange.get("client_secret"), secrets.GITHUB_CLIENT_SECRET);
	assert.equal(exchange.get("redirect_uri"), at("/auth/github/callback"));
	assert.equal(base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(exchange.get("code_verifier") as string)))), authorize.searchParams.get("code_challenge"));
	assert.match(github.userAuthorizations.at(-1) ?? "", /^Bearer ghu_/u);

	// Where the browser lands: the app's page, its state, our issuer, and a code of ours.
	assert.equal(`${landing.origin}${landing.pathname}`, APP);
	assert.equal(landing.searchParams.get("state"), client.state);
	assert.equal(landing.searchParams.get("iss"), base.origin);

	const redeemed = await redeem(client, landing.searchParams.get("code") as string);

	assert.equal(redeemed.status, 200);
	assert.equal(redeemed.body["token_type"], "DPoP");

	const env = await worker.getEnv() as { "DB": D1Database };
	const user = await env.DB.prepare("SELECT users.id, users.github_id FROM users JOIN grants ON grants.user_id = users.id WHERE grants.id = ?").bind((landing.searchParams.get("code") as string).split(".")[0]).first<{ "id": string; "github_id": number }>();

	assert.equal(user?.github_id, 4242);
	assert.equal(JSON.stringify(await env.DB.prepare("SELECT * FROM users").all()).includes("octocat"), false, "no login or email kept");
});

test("our code is bound to the app that started: another key can't redeem it", async () => {
	const client = await app();
	const { landing } = await signIn(client);
	const thief = { ...await app(), "verifier": client.verifier };

	assert.deepEqual((await redeem(thief, landing.searchParams.get("code") as string)).body, { "error": "invalid_grant" });
});

test("the callback refuses a state it didn't seal, or one that's expired", async () => {
	const forged = await fetchFrom(`${at("/auth/github/callback")}?code=x&state=v1.AAAA.BBBB`, { "redirect": "manual" });

	assert.equal(forged.status, 400);
	assert.equal(forged.headers.get("location"), null);

	const client = await app();
	const expired = await seal(secrets.STATE_KEY, JSON.stringify({ "redirectUri": APP, "state": client.state, "codeChallenge": client.challenge, "jkt": client.jkt, "verifier": "v", "expires": Date.now() - 1 }), "github-state");
	const late = await fetchFrom(`${at("/auth/github/callback")}?${new URLSearchParams({ "code": "x", "state": expired })}`, { "redirect": "manual" });

	assert.equal(late.status, 400);
});

test("a refusal at GitHub goes back to the app as access_denied, a failed exchange as server_error", async () => {
	const client = await app();
	const started = new URL((await fetchFrom(startUrl(client), { "redirect": "manual" })).headers.get("location") as string);
	const denied = await fetchFrom(`${at("/auth/github/callback")}?${new URLSearchParams({ "error": "access_denied", "state": started.searchParams.get("state") as string })}`, { "redirect": "manual" });
	const deniedAt = new URL(denied.headers.get("location") as string);

	assert.equal(deniedAt.searchParams.get("error"), "access_denied");
	assert.equal(deniedAt.searchParams.get("state"), client.state);
	assert.equal(deniedAt.searchParams.has("code"), false);

	github.next.exchange = "refused";

	try {
		const { landing } = await signIn(await app());

		assert.equal(landing.searchParams.get("error"), "server_error");
		assert.equal(landing.searchParams.has("code"), false);
	} finally {
		github.next.exchange = "ok";
	}
});

test("a GitHub /user without a numeric id is a server_error, and starts no grant", async () => {
	const before = (await worker.listDurableObjectIds("GRANTS")).length;

	github.next.id = "4242";

	try {
		const { landing } = await signIn(await app());

		assert.equal(landing.searchParams.get("error"), "server_error");
		assert.equal((await worker.listDurableObjectIds("GRANTS")).length, before);
	} finally {
		github.next.id = 4242;
	}
});

test("the metadata a client discovers us by", async () => {
	const metadata = await (await fetchFrom(at("/.well-known/oauth-authorization-server"))).json() as Record<string, unknown>;

	assert.equal(metadata["issuer"], base.origin);
	assert.equal(metadata["authorization_endpoint"], at("/auth/github/start"));
	assert.equal(metadata["token_endpoint"], at("/token"));
	assert.deepEqual(metadata["code_challenge_methods_supported"], ["S256"]);
	assert.equal(metadata["authorization_response_iss_parameter_supported"], true);
});

test("no GitHub token, client secret, code or sealed state reaches the logs", async () => {
	const logs = JSON.stringify(server.getLogs());
	const exchanged = github.exchanges.flatMap((exchange) => [exchange.get("code"), exchange.get("code_verifier")]).filter((value): value is string => value !== null);

	assert.ok(github.issued.size > 0);
	assert.deepEqual([...github.issued, ...exchanged, secrets.GITHUB_CLIENT_SECRET].filter((value) => logs.includes(value)), []);
	assert.doesNotMatch(logs, /v1\.[\w-]{16,}\.[\w-]{16,}/u, "no sealed state");
});
