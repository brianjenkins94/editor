import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { base64url, calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTestHarness } from "wrangler";
import { BROWSER } from "./browser.ts";

// A3 in workerd: a sign-in as A0's GitHub callback will start it (Grant.begin), then everything the browser does with
// it — /token, /me, refresh, /revoke — with DPoP proofs from a key of the test's own, as the shell's will be.

const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "test" };
const secrets = {
	"SIGNING_JWK": JSON.stringify(signing),
	"NONCE_KEY": "nonce key for the tests",
	"TOKEN_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	"AUDIT_KEY": "audit key for the tests"
};
// GitHub nowhere: revoking a grant also revokes its token at GitHub, best effort, and these tests have no GitHub.
const server = createTestHarness({ "root": new URL("..", import.meta.url).pathname, "workers": [{ "configPath": "wrangler.jsonc", secrets, "vars": { "GITHUB_ORIGIN": "http://127.0.0.1:9", "GITHUB_API": "http://127.0.0.1:9" } }] });
const worker = server.getWorker();
let base: URL;
// The Worker's bindings, as the GitHub callback has them: the Grant namespace and D1.
let env: { "GRANTS": { "newUniqueId": () => DurableObjectId; "idFromString": (id: string) => DurableObjectId; "get": (id: DurableObjectId) => { "begin": (options: unknown) => Promise<{ "code": string }>; "abandon": () => Promise<void> } }; "DB": D1Database };

// Every secret value the flow handles, for the redaction test at the end.
const handled = new Set<string>();

before(async () => {
	({ "url": base } = await server.listen());
	await worker.applyD1Migrations("DB");
	env = await worker.getEnv() as typeof env;
});

after(async () => {
	await server.close();
});

const at = (path: string): string => new URL(path, base).href;

/** A request from an IP of its own (TEST-NET-2), so the functional tests never meet the per-IP rate limits. */
const anyIp = (): string => `198.51.100.${Math.floor(Math.random() * 254) + 1}`;

const fetchFrom = async (url: string, init: { "method"?: string; "headers"?: Record<string, string>; "body"?: string; "redirect"?: "manual" } = {}): Promise<Awaited<ReturnType<typeof server.fetch>>> => server.fetch(url, { ...init, "headers": { "cf-connecting-ip": anyIp(), ...BROWSER, ...init.headers } });

/** A response, as the harness gives it (miniflare's Response, not the Workers one). */
type Answer = Awaited<ReturnType<typeof server.fetch>>;

/** A browser: a DPoP key of its own, and the last nonce the server gave it. */
async function browser(): Promise<{ "jkt": string; "nonce"?: string; "proof": (method: string, url: string, claims?: Record<string, unknown>) => Promise<string> }> {
	const { privateKey, publicKey } = await generateKeyPair("ES256");
	const jwk = await exportJWK(publicKey);
	const client = {
		"jkt": await calculateJwkThumbprint(jwk),
		"nonce": undefined as string | undefined,
		"proof": async (method: string, url: string, claims: Record<string, unknown> = {}) => {
			const proof = await new SignJWT({ "htm": method, "htu": url, "jti": crypto.randomUUID(), "iat": Math.floor(Date.now() / 1000), ...client.nonce === undefined ? {} : { "nonce": client.nonce }, ...claims })
				.setProtectedHeader({ "typ": "dpop+jwt", "alg": "ES256", "jwk": jwk })
				.sign(privateKey);

			handled.add(proof);

			return proof;
		}
	};

	return client;
}

type Browser = Awaited<ReturnType<typeof browser>>;

/** A request with a fresh proof; a `use_dpop_nonce` answer is retried once with the nonce it brought, as oauth4webapi does. */
async function send(client: Browser, method: string, path: string, { form, accessToken }: { "form"?: Record<string, string>; "accessToken"?: string } = {}): Promise<Answer> {
	for (let attempt = 0; ; attempt += 1) {
		const headers: Record<string, string> = { "dpop": await client.proof(method, at(path), accessToken === undefined ? {} : { "ath": base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(accessToken)))) }) };

		if (accessToken !== undefined) {
			headers["authorization"] = `DPoP ${accessToken}`;
		}

		const response = await fetchFrom(at(path), { "method": method, "headers": headers, ...form === undefined ? {} : { "body": new URLSearchParams(form).toString(), "headers": { ...headers, "content-type": "application/x-www-form-urlencoded" } } });

		client.nonce = response.headers.get("dpop-nonce") ?? client.nonce;

		if (attempt === 0 && response.headers.has("dpop-nonce") && (response.status === 400 || response.status === 401)) {
			const body = await response.clone().json() as { "error"?: string };

			if (body.error === "use_dpop_nonce") {
				continue;
			}
		}

		return response;
	}
}

/** What GitHub's callback will do (A0): start a sign-in for GitHub user `githubId`, bound to `client`'s key. */
async function signIn(client: Browser, githubId: number): Promise<{ "code": string; "verifier": string; "grantId": string }> {
	const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	const id = env.GRANTS.newUniqueId();
	const github = { "accessToken": `ghu_${crypto.randomUUID()}`, "refreshToken": `ghr_${crypto.randomUUID()}`, "expiresAt": Date.now() + 28_800_000, "refreshExpiresAt": Date.now() + 15_897_600_000 };
	const { code } = await env.GRANTS.get(id).begin({ "githubId": githubId, "github": github, "codeChallenge": challenge, "jkt": client.jkt, "from": { "country": null, "ipHash": null } });

	[code, verifier, github.accessToken, github.refreshToken].forEach((value) => handled.add(value));

	return { "code": code, "verifier": verifier, "grantId": id.toString() };
}

interface Tokens { "access_token": string; "refresh_token": string; "token_type": string; "expires_in": number }

async function redeem(client: Browser, code: string, verifier: string): Promise<Answer> {
	return send(client, "POST", "/token", { "form": { "grant_type": "authorization_code", "code": code, "code_verifier": verifier, "client_id": "editor" } });
}

async function refresh(client: Browser, refreshToken: string): Promise<Answer> {
	return send(client, "POST", "/token", { "form": { "grant_type": "refresh_token", "refresh_token": refreshToken, "client_id": "editor" } });
}

async function tokens(response: Answer): Promise<Tokens> {
	assert.equal(response.status, 200, await response.clone().text());

	const body = await response.json() as Tokens;

	handled.add(body.access_token);
	handled.add(body.refresh_token);

	return body;
}

async function audit(grantId: string): Promise<string[]> {
	return (await env.DB.prepare("SELECT event FROM audit WHERE grant_id = ? ORDER BY id").bind(grantId).all<{ "event": string }>()).results.map((row) => row.event);
}

test("a sign-in: the code for DPoP-bound tokens, /me, then a refresh", async () => {
	const client = await browser();
	const { code, verifier, grantId } = await signIn(client, 101);
	const first = await tokens(await redeem(client, code, verifier));

	assert.equal(first.token_type, "DPoP");
	assert.equal(first.expires_in, 300);

	const me = await send(client, "GET", "/me", { "accessToken": first.access_token });
	const user = await env.DB.prepare("SELECT users.id FROM users JOIN grants ON grants.user_id = users.id WHERE grants.id = ?").bind(grantId).first<{ "id": string }>();

	assert.equal(me.status, 200);
	assert.deepEqual(await me.json(), { "user": user?.id });

	const second = await tokens(await refresh(client, first.refresh_token));

	assert.notEqual(second.refresh_token, first.refresh_token);
	assert.equal((await send(client, "GET", "/me", { "accessToken": second.access_token })).status, 200);
	assert.deepEqual(await audit(grantId), ["login", "token_issued", "refreshed"]);
});

test("the same GitHub user signing in again is the same user, with another grant", async () => {
	const client = await browser();
	const one = await signIn(client, 102);
	const two = await signIn(client, 102);
	const users = await env.DB.prepare("SELECT DISTINCT user_id FROM grants WHERE id IN (?, ?)").bind(one.grantId, two.grantId).all();

	assert.notEqual(one.grantId, two.grantId);
	assert.equal(users.results.length, 1);
});

test("a code works once, with its verifier and the key the sign-in started with", async () => {
	const client = await browser();
	const wrongVerifier = await signIn(client, 103);

	assert.deepEqual(await (await redeem(client, wrongVerifier.code, "not the verifier")).json(), { "error": "invalid_grant" });
	assert.deepEqual(await (await redeem(client, wrongVerifier.code, wrongVerifier.verifier)).json(), { "error": "invalid_grant" }, "spent by the wrong attempt");

	const used = await signIn(client, 103);

	await tokens(await redeem(client, used.code, used.verifier));
	assert.deepEqual(await (await redeem(client, used.code, used.verifier)).json(), { "error": "invalid_grant" }, "twice");

	const stolen = await signIn(client, 103);

	assert.deepEqual(await (await redeem(await browser(), stolen.code, stolen.verifier)).json(), { "error": "invalid_grant" }, "another key");
});

test("a refresh token used twice revokes the sign-in", async () => {
	const client = await browser();
	const { code, verifier, grantId } = await signIn(client, 104);
	const first = await tokens(await redeem(client, code, verifier));
	const second = await tokens(await refresh(client, first.refresh_token));

	assert.deepEqual(await (await refresh(client, first.refresh_token)).json(), { "error": "invalid_grant" });
	assert.deepEqual(await (await refresh(client, second.refresh_token)).json(), { "error": "invalid_grant" }, "the newest one too");

	const me = await send(client, "GET", "/me", { "accessToken": second.access_token });

	assert.equal(me.status, 401);
	assert.match(me.headers.get("www-authenticate") ?? "", /^DPoP error="invalid_token"/u);
	assert.deepEqual(await audit(grantId), ["login", "token_issued", "refreshed", "refresh_reuse_detected", "grant_revoked", "token_rejected", "auth_refused"]);

	// Every row says why, and joins to its request's trace.
	const refused = await env.DB.prepare("SELECT reason, detail, trace_id FROM audit WHERE grant_id = ? AND event = 'auth_refused'").bind(grantId).first<{ "reason": string; "detail": string; "trace_id": string }>();

	assert.deepEqual({ ...refused, "trace_id": /^[0-9a-f]{32}$/u.test(refused?.trace_id ?? "") }, { "reason": "grant revoked", "detail": "GET /me", "trace_id": true });
	assert.notEqual((await env.DB.prepare("SELECT revoked_at FROM grants WHERE id = ?").bind(grantId).first<{ "revoked_at": number | null }>())?.revoked_at, null);
});

test("a refresh token with another key's proof is refused, and the sign-in lives on", async () => {
	const client = await browser();
	const { code, verifier } = await signIn(client, 105);
	const issued = await tokens(await redeem(client, code, verifier));

	assert.deepEqual(await (await refresh(await browser(), issued.refresh_token)).json(), { "error": "invalid_grant" });
	await tokens(await refresh(client, issued.refresh_token));
});

test("/me refuses without the token, with Bearer, with another key's proof, without the token's hash, a replayed proof, or a token we didn't sign", async () => {
	const client = await browser();
	const { code, verifier } = await signIn(client, 106);
	const issued = await tokens(await redeem(client, code, verifier));
	const unauthorized = async (response: Answer, error: string): Promise<void> => {
		assert.equal(response.status, 401);
		assert.match(response.headers.get("www-authenticate") ?? "", new RegExp(`^DPoP error="${error}"`, "u"));
	};

	await unauthorized(await fetchFrom(at("/me")), "invalid_token");
	await unauthorized(await fetchFrom(at("/me"), { "headers": { "authorization": `Bearer ${issued.access_token}` } }), "invalid_token");
	await unauthorized(await send(await browser(), "GET", "/me", { "accessToken": issued.access_token }), "invalid_dpop_proof");
	// The right key, but a proof that doesn't carry this token's hash (ath): it could be paired with another token.
	await unauthorized(await fetchFrom(at("/me"), { "headers": { "authorization": `DPoP ${issued.access_token}`, "dpop": await client.proof("GET", at("/me")) } }), "invalid_dpop_proof");

	const proof = await client.proof("GET", at("/me"), { "ath": base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(issued.access_token)))) });
	const headers = { "authorization": `DPoP ${issued.access_token}`, "dpop": proof };

	assert.equal((await fetchFrom(at("/me"), { "headers": headers })).status, 200);
	await unauthorized(await fetchFrom(at("/me"), { "headers": headers }), "invalid_dpop_proof");

	const forged = await new SignJWT({ "client_id": "editor", "cnf": { "jkt": client.jkt }, "grant": "x" })
		.setProtectedHeader({ "typ": "at+jwt", "alg": "ES256", "kid": "test" })
		.setIssuer(base.origin).setAudience(base.origin).setSubject("someone").setIssuedAt().setExpirationTime("5m").setJti("j")
		.sign((await generateKeyPair("ES256")).privateKey);

	await unauthorized(await send(client, "GET", "/me", { "accessToken": forged }), "invalid_token");
});

test("/revoke ends a sign-in", async () => {
	const client = await browser();
	const { code, verifier, grantId } = await signIn(client, 107);
	const issued = await tokens(await redeem(client, code, verifier));
	const response = await send(client, "POST", "/revoke", { "form": { "token": issued.refresh_token } });

	assert.equal(response.status, 200);
	assert.deepEqual(await (await refresh(client, issued.refresh_token)).json(), { "error": "invalid_grant" });
	assert.equal((await send(client, "GET", "/me", { "accessToken": issued.access_token })).status, 401);
	assert.deepEqual((await audit(grantId)).slice(-3), ["grant_revoked", "token_rejected", "auth_refused"], "and the refresh and /me tried after it");
});

test("a code for a grant that doesn't exist is refused without creating one", async () => {
	const before = (await worker.listDurableObjectIds("GRANTS")).length;
	const forged = `${env.GRANTS.newUniqueId().toString()}.secret`;

	assert.deepEqual(await (await redeem(await browser(), forged, "verifier")).json(), { "error": "invalid_grant" });
	assert.equal((await worker.listDurableObjectIds("GRANTS")).length, before);
});

test("GitHub's tokens are sealed at rest, and gone once the sign-in is revoked", async () => {
	const client = await browser();
	const { code, verifier, grantId } = await signIn(client, 108);
	const storage = await worker.getDurableObjectStorage("GRANTS", { "id": grantId });
	const [row] = await storage.exec<{ "github": string }>("SELECT github FROM state");

	assert.match(row?.github ?? "", /^v1\.[\w-]+\.[\w-]+$/u);
	assert.equal([...handled].some((value) => value.startsWith("gh") && (row?.github ?? "").includes(value)), false);

	const issued = await tokens(await redeem(client, code, verifier));

	await send(client, "POST", "/revoke", { "form": { "token": issued.refresh_token } });
	assert.deepEqual(await storage.exec("SELECT github FROM state"), [{ "github": null }]);
});

// The alarm is the platform's to fire when the code would expire (alarm() is reserved over RPC); it calls abandon().
test("a sign-in never redeemed ends when its code would have: GitHub's tokens wiped", async () => {
	const client = await browser();
	const abandoned = await signIn(client, 110);
	const storage = await worker.getDurableObjectStorage("GRANTS", { "id": abandoned.grantId });

	await env.GRANTS.get(env.GRANTS.idFromString(abandoned.grantId)).abandon();
	assert.deepEqual(await storage.exec("SELECT github FROM state"), [{ "github": null }]);
	assert.deepEqual((await audit(abandoned.grantId)).slice(-1), ["grant_revoked"]);
	assert.deepEqual(await (await redeem(client, abandoned.code, abandoned.verifier)).json(), { "error": "invalid_grant" });

	// One that was redeemed is the browser's now: the alarm leaves it alone.
	const finished = await signIn(client, 110);
	const issued = await tokens(await redeem(client, finished.code, finished.verifier));

	await env.GRANTS.get(env.GRANTS.idFromString(finished.grantId)).abandon();
	assert.equal((await send(client, "GET", "/me", { "accessToken": issued.access_token })).status, 200);
});

test("the audit log keeps an IP only as a hash", async () => {
	const client = await browser();
	const { code, verifier, grantId } = await signIn(client, 109);
	const proof = await client.proof("POST", at("/token"));

	await fetchFrom(at("/token"), { "method": "POST", "headers": { "dpop": proof, "cf-connecting-ip": "203.0.113.7", "content-type": "application/x-www-form-urlencoded" }, "body": new URLSearchParams({ "grant_type": "authorization_code", "code": code, "code_verifier": verifier, "client_id": "editor" }).toString() });
	await tokens(await redeem(client, code, verifier)).catch(() => undefined);

	const rows = (await env.DB.prepare("SELECT ip_hash FROM audit WHERE grant_id = ? AND ip_hash IS NOT NULL").bind(grantId).all<{ "ip_hash": string }>()).results;

	assert.equal(JSON.stringify(await env.DB.prepare("SELECT * FROM audit").all()).includes("203.0.113.7"), false);
	assert.equal(rows.every((row) => /^[\w-]{22}$/u.test(row.ip_hash)), true);
});

test("CORS: the allowed origins, and no others", async () => {
	const preflight = async (origin: string): Promise<Answer> => fetchFrom(at("/token"), { "method": "OPTIONS", "headers": { "origin": origin, "access-control-request-method": "POST", "access-control-request-headers": "dpop, content-type" } });
	const allowed = await preflight("http://localhost:5173");

	assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:5173");
	assert.equal((await preflight("https://evil.example.com")).headers.get("access-control-allow-origin"), null);

	const exposed = await fetchFrom(at("/health"), { "headers": { "origin": "http://localhost:5173" } });

	assert.match(exposed.headers.get("access-control-expose-headers") ?? "", /dpop-nonce/u);
});

// Last: everything above went through the logs, and none of what it handled may be in them.
test("no code, verifier, token, proof or GitHub token reaches the logs", async () => {
	const logs = JSON.stringify(server.getLogs());

	assert.ok(handled.size > 50, `only ${handled.size} values were handled`);
	assert.deepEqual([...handled].filter((value) => logs.includes(value)), []);
	assert.match(logs, /reason: 'jti was seen before'/u, "refusals are logged, by their reason");
});
