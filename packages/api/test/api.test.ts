import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createTestHarness } from "wrangler";

// The Worker runs in workerd, built from wrangler.jsonc exactly as `wrangler dev` builds it.
const server = createTestHarness({ "root": new URL("..", import.meta.url).pathname, "workers": [{ "configPath": "wrangler.jsonc" }] });

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
