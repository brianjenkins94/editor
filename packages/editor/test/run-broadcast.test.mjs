/**
 * A run's BroadcastChannel (extensions/tsval/worker/broadcast.ts): Node's is the process's own, so a run's is the run's —
 * channels of one name in it hear each other (not the one that posted), a channel closed hears nothing, and nothing
 * reaches the origin's other tabs, the editor's own among them, as the browser's would. Each run, a fresh one.
 *
 *   node --import tsx --test test/run-broadcast.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { runBroadcastChannel } = await import("../extensions/tsval/worker/broadcast.ts");

const settled = async () => new Promise((resolve) => { setTimeout(resolve, 5); });

test("channels of one name in a run hear each other, not the one that posted; a closed one hears nothing", async () => {
	const Channel = runBroadcastChannel();
	const [one, two, three, elsewhere] = [new Channel("hub"), new Channel("hub"), new Channel("hub"), new Channel("other")];
	const heard = [];

	one.onmessage = (event) => { heard.push(["one", event.data]); };
	two.addEventListener("message", (event) => { heard.push(["two", event.data]); });
	three.onmessage = (event) => { heard.push(["three", event.data]); };
	elsewhere.onmessage = (event) => { heard.push(["elsewhere", event.data]); };
	three.close();
	one.postMessage({ "said": 1 });
	await settled();

	assert.deepEqual(heard, [["two", { "said": 1 }]]);
	assert.throws(() => { three.postMessage("late"); }, /closed/u);
});

test("another run's channels are another run's", async () => {
	const [mine, theirs] = [new (runBroadcastChannel())("hub"), new (runBroadcastChannel())("hub")];
	const heard = [];

	theirs.onmessage = (event) => { heard.push(event.data); };
	mine.postMessage("hello");
	await settled();

	assert.deepEqual(heard, []);
});
