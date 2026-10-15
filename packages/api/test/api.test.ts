import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { exportJWK, generateKeyPair } from "jose";
import { createTestHarness } from "wrangler";

// A signing key of the test's own, as the SIGNING_JWK secret.
const signing = { ...await exportJWK((await generateKeyPair("ES256", { "extractable": true })).privateKey), "alg": "ES256", "kid": "test" };

// The Worker runs in workerd, built from wrangler.jsonc exactly as `wrangler dev` builds it.
const server = createTestHarness({ "root": new URL("..", import.meta.url).pathname, "workers": [{ "configPath": "wrangler.jsonc", "secrets": { "SIGNING_JWK": JSON.stringify(signing) } }] });

before(async () => {
	await server.listen();
});

after(async () => {
	await server.close();
});

test("/health answers with the environment", async () => {
	const response = await server.fetch("/health");

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { "ok": true, "environment": "local" });
});

test("security headers are set", async () => {
	const response = await server.fetch("/health");

	assert.equal(response.headers.get("x-content-type-options"), "nosniff");
	assert.equal(response.headers.get("x-frame-options"), "SAMEORIGIN");
});

test("an unknown path is a JSON 404", async () => {
	const response = await server.fetch("/nope");

	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), { "error": "not_found" });
});

test("a request is logged without its query string or headers", async () => {
	server.clearLogs();

	await server.fetch("/health?code=SECRET-CODE&state=SECRET-STATE", { "headers": { "authorization": "DPoP SECRET-TOKEN" } });

	const logs = JSON.stringify(server.getLogs());

	assert.match(logs, /path: '\/health'/u);
	assert.doesNotMatch(logs, /SECRET/u);
});

test("the JWKS has the signing key's public half, and nothing private", async () => {
	const response = await server.fetch("/.well-known/jwks.json");
	const { keys } = await response.json() as { "keys": Record<string, string>[] };

	assert.equal(response.status, 200);
	assert.deepEqual(keys, [{ "kty": "EC", "crv": "P-256", "x": signing.x, "y": signing.y, "alg": "ES256", "kid": "test" }]);
	assert.equal(JSON.stringify(keys).includes(signing.d as string), false);
});
