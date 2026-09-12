import * as assert from "node:assert/strict";
import { test } from "node:test";

import type { Transport } from "../src/index.ts";
import { createHub, matches } from "../src/index.ts";

/** A connected pair of in-memory transports — delivery is async (a macrotask) to mirror postMessage, so tests
 *  `await flush()` to let interest control and messages settle across hops. */
function pipe(): [Transport, Transport] {
	let left: ((message: unknown) => void) | undefined;
	let right: ((message: unknown) => void) | undefined;

	return [
		{ "send": (message) => { setTimeout(() => right?.(message), 0); }, "listen": (onMessage) => { left = onMessage; return () => { left = undefined; }; } },
		{ "send": (message) => { setTimeout(() => left?.(message), 0); }, "listen": (onMessage) => { right = onMessage; return () => { right = undefined; }; } }
	];
}

/** Let queued deliveries (across several hops) drain. */
function flush(): Promise<void> {
	return new Promise((resolve) => { setTimeout(resolve, 10); });
}

test("subject matching", () => {
	assert.ok(matches("a.b", "a.b"));
	assert.ok(matches("a.*", "a.b"));
	assert.ok(matches("a.>", "a.b.c"));
	assert.ok(!matches("a.*", "a.b.c"));
	assert.ok(!matches("a.b", "a.c"));
	assert.ok(!matches("a.>", "a")); // `>` needs at least one more token
});

test("local publish reaches local subscribers", () => {
	const hub = createHub({ "id": "solo" });
	const seen: unknown[] = [];

	hub.subscribe("render.mutation", (data) => { seen.push(data); });
	hub.subscribe("render.>", (data) => { seen.push(["wild", data]); });
	hub.publish("render.mutation", 1);
	hub.publish("render.other", 2);

	assert.deepEqual(seen, [1, ["wild", 1], ["wild", 2]]);
});

test("linked hubs federate a subscribed subject in both directions", async () => {
	const [a, b] = pipe();
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });

	root.link(a);
	pod.link(b);

	const atPod: unknown[] = [];
	const atRoot: unknown[] = [];

	pod.subscribe("cmd.run", (data) => { atPod.push(data); });
	root.subscribe("peer.pod", (data) => { atRoot.push(data); });

	await flush(); // interest propagates across the link

	root.publish("cmd.run", "go");
	pod.publish("peer.pod", "ack");

	await flush();

	assert.deepEqual(atPod, ["go"]);
	assert.deepEqual(atRoot, ["ack"]);
});

test("local traffic stays local — an unsubscribed subject never crosses the link", async () => {
	const [a, b] = pipe();
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });

	root.link(a);
	pod.link(b);

	// The far side only wants `cmd.run`; it must never receive pod-local chatter.
	const atRoot: unknown[] = [];
	root.subscribe("cmd.run", (data) => { atRoot.push(data); });

	await flush();

	let crossed = false;
	root.subscribe("pod.internal", () => { crossed = true; }); // subscribed AFTER interest settled; still shouldn't arrive from a pre-existing publish
	pod.publish("pod.internal", "secret");

	await flush();

	assert.equal(crossed, false);
	assert.deepEqual(atRoot, []);
});

test("three-level tree: interest propagates up, messages route down", async () => {
	const [rootEnd, podUp] = pipe();
	const [podDown, workerEnd] = pipe();

	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });
	const worker = createHub({ "id": "worker" });

	root.link(rootEnd);
	pod.link(podUp);
	pod.link(podDown);
	worker.link(workerEnd);

	const atWorker: unknown[] = [];
	worker.subscribe("ping", (data) => { atWorker.push(data); });

	await flush(); // worker → pod → root interest propagation

	root.publish("ping", 42); // published at the very top; must reach the leaf

	await flush();

	assert.deepEqual(atWorker, [42]);
});

test("unlink stops federation and withdraws interest", async () => {
	const [a, b] = pipe();
	const root = createHub({ "id": "root" });
	const pod = createHub({ "id": "pod" });

	root.link(a);
	const unlink = pod.link(b);

	const atPod: unknown[] = [];
	pod.subscribe("cmd.run", (data) => { atPod.push(data); });

	await flush();
	root.publish("cmd.run", "before");
	await flush();

	unlink();
	root.publish("cmd.run", "after");
	await flush();

	assert.deepEqual(atPod, ["before"]);
});
