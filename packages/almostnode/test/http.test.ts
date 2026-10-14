/**
 * The http shim's streamed serve (shims/http.ts, Server.serve): the answer comes at the head, the body as it's written, a
 * full queue holding the writer back until the reader takes some, a reader hanging up closing the request — and a
 * request body read as the handler reads it.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";

// (almostnode's sources import each other without extensions: see extensionless.mjs.)
import "./extensionless.mjs";

const { createServer } = await import("../shims/http.ts");

type Request = Parameters<Parameters<typeof createServer>[0] & object>[0];
type Response = Parameters<Parameters<typeof createServer>[0] & object>[1];

/** Wait until `ready()` holds. */
async function until(ready: () => boolean, what: string): Promise<void> {
	for (const started = Date.now(); !ready(); await new Promise((resolve) => { setTimeout(resolve, 5); })) {
		if (Date.now() - started > 5000) {
			throw new Error("timed out waiting for " + what);
		}
	}
}

const text = (bytes: Uint8Array | undefined): string => new TextDecoder().decode(bytes);

test("the answer comes at the head, and the body as it's written", async () => {
	let respond: Response | undefined;
	const server = createServer((_request: Request, response: Response) => {
		response.writeHead(200, { "content-type": "text/event-stream" });
		respond = response;
	});

	const answer = await server.serve("GET", "/events", {});

	assert.equal(answer.statusCode, 200);
	assert.equal(answer.headers["content-type"], "text/event-stream");

	const reader = answer.body.getReader();
	const first = reader.read();

	respond!.write("data: one\n\n");
	assert.equal(text((await first).value), "data: one\n\n");

	respond!.end("data: two\n\n");
	assert.equal(text((await reader.read()).value), "data: two\n\n");
	assert.equal((await reader.read()).done, true);
});

test("a response written and ended at once arrives whole", async () => {
	const server = createServer((_request: Request, response: Response) => {
		response.setHeader("content-type", "text/plain");
		response.end("hello");
	});
	const answer = await server.serve("GET", "/", {});
	const reader = answer.body.getReader();

	assert.equal(text((await reader.read()).value), "hello");
	assert.equal((await reader.read()).done, true);
});

test("a full queue says so to the writer, and drain follows once the reader takes some", async () => {
	let respond: Response | undefined;
	const server = createServer((_request: Request, response: Response) => {
		respond = response;
		response.flushHeaders();
	});
	const answer = await server.serve("GET", "/big", {});
	const piece = new Uint8Array(16 * 1024);
	let drained = false;

	respond!.on("drain", () => { drained = true; });

	const accepted = [1, 2, 3, 4, 5].map(() => respond!.write(piece));

	assert.deepEqual(accepted, [true, true, true, false, false], "64 KiB queued, then held back");

	const reader = answer.body.getReader();

	await reader.read();
	await reader.read();
	await until(() => drained, "drain, once under 64 KiB again");
	respond!.end();
	reader.releaseLock();
	await answer.body.cancel();
});

test("a reader hanging up closes the request and the response", async () => {
	let closed = 0;
	const server = createServer((request: Request, response: Response) => {
		request.on("close", () => { closed += 1; });
		response.on("close", () => { closed += 1; });
		response.writeHead(200);
	});
	const answer = await server.serve("GET", "/events", {});

	await answer.body.cancel();
	assert.equal(closed, 2);
});

test("a request body streamed in is read as the handler reads it", async () => {
	let feed!: ReadableStreamDefaultController<Uint8Array>;
	const body = new ReadableStream<Uint8Array>({ "start": (controller) => { feed = controller; } });
	const server = createServer((request: Request, response: Response) => {
		const pieces: string[] = [];

		request.on("data", (chunk: Uint8Array) => { pieces.push(text(chunk)); });
		request.on("end", () => { response.end(pieces.join("|")); });
	});
	const answering = server.serve("POST", "/upload", { "content-type": "text/plain" }, body);

	feed.enqueue(new TextEncoder().encode("a"));
	feed.enqueue(new TextEncoder().encode("b"));
	await new Promise((resolve) => { setTimeout(resolve, 10); });
	feed.enqueue(new TextEncoder().encode("c"));
	feed.close();

	const answer = await answering;

	assert.equal(text((await answer.body.getReader().read()).value), "a|b|c");
});
