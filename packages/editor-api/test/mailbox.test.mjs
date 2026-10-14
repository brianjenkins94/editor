/**
 * The runtime's mailbox (src/runtime.ts): a worker's synchronous calls, answered asynchronously by the other side —
 * here a worker thread asking, this thread answering — with what doesn't fit going in pieces.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { Worker } from "node:worker_threads";
import { answerMailbox, createMailbox } from "../src/runtime.ts";

const ASKER = `
	import { workerData, parentPort } from "node:worker_threads";
	import { askMailbox } from ${JSON.stringify(new URL("../src/runtime.ts", import.meta.url).href)};

	const answers = workerData.calls.map(([meta, size]) => {
		const answer = askMailbox(workerData.mailbox, meta, size === undefined ? undefined : new Uint8Array(size).map((_, index) => index % 251));

		return { "meta": answer.meta, "failed": answer.failed, "length": answer.payload.length, "intact": answer.payload.every((byte, index) => byte === index % 251) };
	});

	parentPort.postMessage(answers);
`;

/** Ask `calls` ([meta, payload size?]) from a worker, through a mailbox with `room` bytes a piece. */
async function ask(calls, room, answer) {
	const mailbox = createMailbox(room);
	const stop = answerMailbox(mailbox, answer);
	const worker = new Worker(new URL("data:text/javascript," + encodeURIComponent(ASKER)), { "workerData": { "mailbox": mailbox, "calls": calls } });

	try {
		return await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
	} finally {
		stop();
		await worker.terminate();
	}
}

const echo = async (meta, payload) => ({ "meta": { ...meta, "got": payload.length, "intact": payload.every((byte, index) => byte === index % 251) }, "payload": new Uint8Array(meta.reply ?? 0).map((_, index) => index % 251) });

test("a call is answered, its bytes both ways", async () => {
	const [answer] = await ask([[{ "op": "echo", "reply": 10 }, 5]], 1024, echo);

	assert.deepEqual(answer, { "meta": { "op": "echo", "reply": 10, "got": 5, "intact": true }, "failed": false, "length": 10, "intact": true });
});

test("a request and an answer bigger than the mailbox go in pieces", async () => {
	const [answer] = await ask([[{ "op": "echo", "reply": 10_000 }, 7_000]], 64, echo);

	assert.equal(answer.failed, false);
	assert.equal(answer.meta.got, 7_000);
	assert.equal(answer.meta.intact, true);
	assert.equal(answer.length, 10_000);
	assert.equal(answer.intact, true);
});

test("a failure comes back as one, with its code", async () => {
	const answers = await ask([[{ "op": "missing" }], [{ "op": "echo", "reply": 1 }]], 1024, async (meta, payload) => {
		if (meta.op === "missing") {
			throw Object.assign(new Error("ENOENT: no such file"), { "code": "ENOENT" });
		}

		return echo(meta, payload);
	});

	assert.deepEqual(answers[0].meta, { "message": "ENOENT: no such file", "code": "ENOENT" });
	assert.equal(answers[0].failed, true);
	assert.equal(answers[1].failed, false, "and the next call is answered as usual");
});
