/**
 * A run's DevTools endpoint (extensions/tsval/worker/devtools.ts): the editor as the browser at 127.0.0.1:9222 inside
 * a run — its realms the targets (each window a page, each worker a worker), their memory as the editor last measured
 * it — answering what a program that reads a browser's memory asks, in the order Chrome answers it.
 *
 *   node --import tsx --test test/devtools-endpoint.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { DEVTOOLS_SOCKET, devtoolsJson, devtoolsSession, targetsOf } = await import("../extensions/tsval/worker/devtools.ts");

const READING = {
	"at": 1,
	"realms": [
		{ "url": "http://localhost:5173/__vscode__/host.html", "scope": "Window", "bytes": 40_000_000 },
		{ "url": "http://localhost:5173/debug-worker.js", "scope": "DedicatedWorkerGlobalScope", "bytes": 9_000_000 },
		{ "url": "http://localhost:5173/sw.js", "scope": "ServiceWorkerGlobalScope", "bytes": 1_000_000 }
	]
};

/** A session's conversation: what it sent, and a way to ask it something. */
function connected(reading = READING) {
	const sent = [];
	const handle = devtoolsSession(async () => reading, (message) => { sent.push(message); });
	let id = 0;

	return {
		sent,
		"ask": async (method, params = {}, sessionId) => {
			id += 1;
			await handle(JSON.stringify({ "id": id, "method": method, "params": params, ...sessionId === undefined ? {} : { "sessionId": sessionId } }));

			return sent.findLast((message) => message.id === id);
		}
	};
}

test("each realm is a target: a window a page, a worker a worker, by its URL", () => {
	assert.deepEqual(targetsOf(READING).map(({ type, url }) => [type, url]), [
		["page", "http://localhost:5173/__vscode__/host.html"],
		["worker", "http://localhost:5173/debug-worker.js"],
		["service_worker", "http://localhost:5173/sw.js"]
	]);
	assert.deepEqual(targetsOf(undefined), [], "before the editor has measured: none");
});

test("/json/version gives the browser's socket, /json the targets; anything else isn't the endpoint's", () => {
	assert.equal(devtoolsJson("/json/version", READING, "ua").webSocketDebuggerUrl, DEVTOOLS_SOCKET);
	assert.equal(devtoolsJson("/json/list", READING, "ua").length, 3);
	assert.equal(devtoolsJson("/other", READING, "ua"), undefined);
});

test("a page attached, its workers auto-attached under it, and each one's heap usage — as a reader of a browser's memory asks", async () => {
	const session = connected();
	const { result } = await session.ask("Target.getTargets");
	const page = result.targetInfos.find((target) => target.type === "page");
	const attached = await session.ask("Target.attachToTarget", { "targetId": page.targetId, "flatten": true });
	const { sessionId } = attached.result;
	const event = session.sent.find((message) => message.method === "Target.attachedToTarget");

	assert.equal(session.sent.indexOf(event) < session.sent.indexOf(attached), true, "the event before the reply, as Chrome sends them");
	assert.deepEqual([event.params.sessionId, event.params.targetInfo.url, event.sessionId], [sessionId, page.url, undefined]);

	await session.ask("Target.setAutoAttach", { "autoAttach": true, "waitForDebuggerOnStart": false, "flatten": true }, sessionId);

	const workers = session.sent.filter((message) => message.method === "Target.attachedToTarget" && message.sessionId === sessionId);

	assert.deepEqual(workers.map((message) => message.params.targetInfo.type), ["worker", "service_worker"], "each worker, on the page's session");

	const pageHeap = await session.ask("Runtime.getHeapUsage", {}, sessionId);
	const workerHeap = await session.ask("Runtime.getHeapUsage", {}, workers[0].params.sessionId);

	assert.deepEqual([pageHeap.result.usedSize, workerHeap.result.usedSize, workerHeap.sessionId], [40_000_000, 9_000_000, workers[0].params.sessionId]);
	await session.ask("Target.setAutoAttach", { "autoAttach": true }, sessionId);
	assert.equal(session.sent.filter((message) => message.method === "Target.attachedToTarget").length, 3, "a worker attached once under a page");
});

test("what it doesn't answer, it says so as Chrome does", async () => {
	const session = connected();

	assert.equal((await session.ask("Page.navigate", { "url": "x" })).error.code, -32601);
	assert.equal((await session.ask("Runtime.getHeapUsage", {}, "no-such-session")).error.code, -32001);
	assert.equal((await session.ask("Target.attachToTarget", { "targetId": "nothing" })).error.code, -32602);
});
