/**
 * Streamed exchanges (src/runtime.ts, `exchanges`): the calls that carry a preview's request and its answer in pieces —
 * an answer read a piece at a time as it's written, a request body sent in writes that may overtake the request itself,
 * a cancel reaching the server, and a request that names no exchange answered whole, as before.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { exchanges } from "../src/runtime.ts";

const text = (bytes) => new TextDecoder().decode(bytes);
const bytes = (string) => new TextEncoder().encode(string);
const request = { "port": 3001, "method": "GET", "url": "/", "headers": {} };

/** A body the test writes to: `push(text)`, `close()`, and whether its reader cancelled. */
function writable() {
	let controller;
	const state = { "cancelled": false };
	const body = new ReadableStream({ "start": (started) => { controller = started; }, "cancel": () => { state.cancelled = true; } });

	return {
		"body": body,
		"state": state,
		"push": (string) => {
			controller.enqueue(bytes(string));
		},
		"close": () => {
			controller.close();
		}
	};
}

test("an answer still being written comes in pieces, until done", async () => {
	const events = writable();
	const answer = exchanges(async () => ({ "status": 200, "statusText": "OK", "headers": { "content-type": "text/event-stream" }, "body": events.body }));

	events.push("data: one\n\n");

	const head = await answer({ ...request, "stream": "s1" });

	assert.equal(head.stream, "s1", "more to read");
	assert.equal(text(head.body), "data: one\n\n", "with what was already written");

	const reading = answer({ "port": 3001, "stream": "s1", "read": true });

	events.push("data: two\n\n");
	events.push("data: three\n\n");
	assert.deepEqual({ ...await reading, "body": text((await reading).body) }, { "body": "data: two\n\ndata: three\n\n", "done": false });

	events.close();

	const last = await answer({ "port": 3001, "stream": "s1", "read": true });

	assert.equal(last.done, true);
});

test("an answer written all at once comes whole, with no exchange left open", async () => {
	const answer = exchanges(async () => ({ "status": 200, "statusText": "OK", "headers": {}, "body": new Blob(["hello"]).stream() }));
	const head = await answer({ ...request, "stream": "s2" });

	assert.equal(head.stream, undefined);
	assert.equal(text(head.body), "hello");
});

test("without an exchange named, a streamed answer is drained and sent whole", async () => {
	const events = writable();
	const answer = exchanges(async () => ({ "status": 200, "statusText": "OK", "headers": {}, "body": events.body }));
	const answering = answer(request);

	events.push("a");
	setTimeout(() => {
		events.push("b");
		events.close();
	}, 10);
	assert.equal(text((await answering).body), "ab");
});

test("a request body in writes reaches the server in order — the first write may overtake the request", async () => {
	const answer = exchanges(async ({ body }) => {
		const reader = body.getReader();
		const pieces = [];

		for (let read = await reader.read(); !read.done; read = await reader.read()) {
			pieces.push(text(read.value));
		}

		return { "status": 200, "statusText": "OK", "headers": {}, "body": bytes(pieces.join("|")) };
	});
	const early = answer({ "port": 3001, "stream": "s3", "write": bytes("one") });
	const answering = answer({ ...request, "method": "POST", "stream": "s3", "more": true });

	await early;
	await answer({ "port": 3001, "stream": "s3", "write": bytes("two"), "end": true });
	assert.equal(text((await answering).body), "one|two");

	assert.deepEqual(await answer({ "port": 3001, "stream": "s3", "write": bytes("late") }), { "ok": false }, "a write after the end is refused");
});

test("a cancel reaches the server's body", async () => {
	const events = writable();
	const answer = exchanges(async () => ({ "status": 200, "statusText": "OK", "headers": {}, "body": events.body }));

	events.push("x");
	await answer({ ...request, "stream": "s4" });
	await answer({ "port": 3001, "stream": "s4", "cancel": true });
	assert.equal(events.state.cancelled, true);
	assert.deepEqual(await answer({ "port": 3001, "stream": "s4", "read": true }), { "body": new Uint8Array(), "done": true }, "nothing left to read");
});
