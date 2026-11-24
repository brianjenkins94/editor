/**
 * A run's `fetch` to a server listening in the same run (extensions/tsval/worker/loopback.ts): answered there, in
 * memory, as Node's loopback would be — never sent out, so never the policy's network call — its method, path, headers
 * (an Origin a browser's fetch couldn't set kept) and body as given. Anywhere else, or a port nothing here listens on,
 * isn't its to answer.
 *
 *   node --import tsx --test test/loopback-fetch.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { answeredHere, answerLocally } = await import("../extensions/tsval/worker/loopback.ts");

/** A server on `port` that answers with what it was asked. */
function serverOn(port) {
	const asked = [];

	return {
		asked,
		"listening": (each) => each === port,
		"answer": async (request) => {
			asked.push(request);

			return { "status": 200, "statusText": "OK", "headers": { "content-type": "application/json" }, "body": new TextEncoder().encode(JSON.stringify({ "path": request.url })) };
		}
	};
}

test("a request to a server here is answered here: once, its method, path, headers and body as given", async () => {
	const local = serverOn(3173);
	const response = await answerLocally("http://127.0.0.1:3173/agent/tool?x=1", { "method": "post", "headers": { "origin": "http://localhost:5173", "content-type": "text/plain" }, "body": "hello" }, local);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { "path": "/agent/tool?x=1" });
	assert.equal(local.asked.length, 1);
	assert.equal(local.asked[0].method, "POST");
	assert.equal(local.asked[0].headers.origin, "http://localhost:5173");
	assert.equal(new TextDecoder().decode(local.asked[0].body), "hello");
});

test("anywhere else, or a port nothing here listens on, isn't its to answer", () => {
	const local = serverOn(3173);

	assert.equal(answerLocally("https://example.com/", undefined, local), undefined);
	assert.equal(answerLocally("http://localhost:4000/", undefined, local), undefined);
	assert.equal(answerLocally(new URL("http://localhost:3173/"), undefined, { ...local, "listening": () => false }), undefined);
	assert.equal(local.asked.length, 0);
});

test("an answer with no body (204) is one", async () => {
	const response = await answerLocally("http://localhost:3173/", undefined, { "listening": () => true, "answer": async () => ({ "status": 204, "statusText": "No Content", "headers": {}, "body": new Uint8Array() }) });

	assert.equal(response.status, 204);
	assert.equal(await response.text(), "");
});

test("a request the run answers itself isn't the network's: a capability stop doesn't ask about it (answeredHere)", () => {
	const local = serverOn(9222);

	assert.equal(answeredHere("http://127.0.0.1:9222/json/version", local), true);
	assert.equal(answeredHere("ws://localhost:9222/devtools/browser/editor", local), true, "a socket too");
	assert.equal(answeredHere("http://127.0.0.1:9223/", local), false, "nothing here on that port");
	assert.equal(answeredHere("https://example.com:9222/", local), false, "not loopback");
	assert.equal(answeredHere("not a url", local), false);
	assert.equal(answeredHere("http://127.0.0.1:9222/", undefined), false, "no run");
});
