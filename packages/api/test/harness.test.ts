import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { base64url, calculateJwkThumbprint, exportJWK, generateKeyPair, SignJWT } from "jose";
import { createTestHarness } from "wrangler";
import { recorded } from "../harness/state.ts";

// C0 (SIGN-IN.md): `recorded` reads everything the API stores, from outside it, and says exactly what an action wrote.
// Here: what a sign-in writes, all of it, and nothing secret in the reading.

const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "test" };
const secrets = { "SIGNING_JWK": JSON.stringify(signing), "NONCE_KEY": "nonce key for the tests", "TOKEN_KEK": base64url.encode(crypto.getRandomValues(new Uint8Array(32))), "AUDIT_KEY": "audit key for the tests" };
const server = createTestHarness({ "root": new URL("..", import.meta.url).pathname, "workers": [{ "configPath": "wrangler.jsonc", secrets, "vars": { "GITHUB_ORIGIN": "http://127.0.0.1:9", "GITHUB_API": "http://127.0.0.1:9" } }] });
let base: URL;

before(async () => {
	({ "url": base } = await server.listen());
	await server.getWorker().applyD1Migrations("DB");
});

after(async () => {
	await server.close();
});

test("a sign-in writes a user, a grant, two audit rows and their copies, and the Grant's state; GitHub's tokens read as sealed", async () => {
	const env = await server.getWorker().getEnv() as { "GRANTS": { "newUniqueId": () => DurableObjectId; "get": (id: DurableObjectId) => { "begin": (options: unknown) => Promise<{ "code": string }> } } };
	const { privateKey, publicKey } = await generateKeyPair("ES256");
	const jwk = await exportJWK(publicKey);
	const verifier = base64url.encode(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	const token = async (code: string, nonce?: string): Promise<Response> => {
		const url = new URL("/token", base).href;
		const proof = await new SignJWT({ "htm": "POST", "htu": url, "jti": crypto.randomUUID(), "iat": Math.floor(Date.now() / 1000), ...nonce === undefined ? {} : { "nonce": nonce } }).setProtectedHeader({ "typ": "dpop+jwt", "alg": "ES256", "jwk": jwk }).sign(privateKey);

		return server.fetch(url, { "method": "POST", "headers": { "dpop": proof, "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "198.51.100.7" }, "body": new URLSearchParams({ "grant_type": "authorization_code", "code": code, "code_verifier": verifier, "client_id": "admin" }).toString() }) as unknown as Response;
	};

	const changes = await recorded(server, async () => {
		const id = env.GRANTS.newUniqueId();
		const { code } = await env.GRANTS.get(id).begin({ "client": "admin", "githubId": 4242, "github": { "accessToken": "ghu_secret", "refreshToken": "ghr_secret", "expiresAt": Date.now() + 3_600_000, "refreshExpiresAt": Date.now() + 1e10 }, "codeChallenge": challenge, "jkt": await calculateJwkThumbprint(jwk), "from": { "country": null, "ipHash": null, "traceId": null } });
		const first = await token(code);

		assert.equal((await token(code, first.headers.get("dpop-nonce") ?? undefined)).status, 200);
	});

	const summary = Object.fromEntries(Object.entries(changes).map(([collection, change]) => [collection.replace(/:[0-9a-f]{12}:/u, ":<grant>:"), `+${change.added.length} ~${change.changed.length} -${change.removed.length}`]));

	assert.deepEqual(summary, {
		"d1:users": "+1 ~0 -0",
		"d1:grants": "+1 ~0 -0",
		"d1:audit": "+2 ~0 -0",
		"r2:AUDIT_COPIES": "+2 ~0 -0",
		"GRANTS:<grant>:state": "+1 ~0 -0",
		"GRANTS:<grant>:seen_jti": "+1 ~0 -0"
	});
	assert.deepEqual(changes["d1:audit"]?.added.map((row) => row["event"]), ["login", "token_issued"]);

	const written = JSON.stringify(changes);

	assert.equal(written.includes("ghu_secret") || written.includes("ghr_secret"), false, "GitHub's tokens never show");
	assert.match(written, /"github":"sealed"/u);
});
