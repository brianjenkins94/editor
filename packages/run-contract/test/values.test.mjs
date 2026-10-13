// A debug session's live values (extensions/worker-pod/live-values.ts): previews, calls, bounds, replays.
import assert from "node:assert/strict";
import { test } from "node:test";

import { LiveRecord, preview } from "../extensions/worker-pod/live-values.ts";

const value = (fields) => ({ "line": 0, "name": "x", "value": "", "kind": "bind", "call": 0, "turns": [], "step": 0, ...fields });

test("a preview, as code would write it — and never a getter", () => {
	assert.equal(preview("d"), "'d'");
	assert.equal(preview(["a", "b", "c", "d", "e", "f"]), "['a', 'b', 'c', 'd', 'e', 'f']");
	assert.equal(preview([1, 2, 3, 4, 5, 6, 7]), "[1, 2, 3, 4, 5, 6, …]");
	assert.equal(preview({ "x": 1, "y": [true] }), "{ x: 1, y: [true] }");
	assert.equal(preview(function twice() {}), "ƒ twice");
	assert.equal(preview([[[1]]]), "[[Array(1)]]");

	let ran = false;
	const tricky = { get "secret"() { ran = true; return 1; } };

	assert.equal(preview(tricky), "{ secret: undefined }");
	assert.equal(ran, false, "the getter never ran");
	assert.ok(preview("x".repeat(100)).endsWith("…") && preview("x".repeat(100)).length === 60);
});

test("a batch: what's new, its calls named once", () => {
	const record = new LiveRecord();

	record.add(value({ "name": "key", "raw": "d", "call": 1, "callee": { "name": "binarySearch", "line": 0 }, "line": 0, "step": 3 }));
	record.add(value({ "name": "mid", "raw": 2, "call": 1, "turns": [0], "line": 4, "step": 9 }));

	assert.deepEqual(record.drain(), {
		"values": [
			{ "line": 0, "name": "key", "value": "'d'", "kind": "bind", "call": 1, "turns": [] },
			{ "line": 4, "name": "mid", "value": "2", "kind": "bind", "call": 1, "turns": [0] }
		],
		"calls": [{ "id": 1, "name": "binarySearch", "line": 0 }],
		"dropped": 0
	});
	assert.equal(record.drain(), undefined, "nothing new");
});

test("bounds: a loop's late turns, a call's later values, later calls — dropped and counted", () => {
	const record = new LiveRecord({ "turns": 2, "perCall": 3, "calls": 1 });

	for (let turn = 0; turn < 4; turn += 1) {
		record.add(value({ "raw": turn, "call": 1, "turns": [turn], "step": turn }));
	}

	record.add(value({ "raw": "late", "call": 1, "step": 10 }));
	record.add(value({ "raw": "full", "call": 1, "step": 11 }));
	record.add(value({ "raw": "another call", "call": 2, "step": 12 }));

	const batch = record.drain();

	assert.deepEqual(batch.values.map((each) => each.value), ["0", "1", "'late'"]);
	assert.equal(batch.dropped, 4, "turns 2 and 3, the call's fourth value, the second call");
});

test("a call whose first value was dropped is named once all the same", () => {
	const record = new LiveRecord({ "turns": 1, "perCall": 10, "calls": 5 });

	record.add(value({ "raw": 1, "call": 1, "turns": [3], "callee": { "name": "f", "line": 0 }, "step": 1 }));
	record.add(value({ "raw": 2, "call": 1, "step": 2 }));

	assert.deepEqual(record.drain().calls, [{ "id": 1, "name": "f", "line": 0 }]);
});

test("stepping back: a replayed value isn't told twice", () => {
	const record = new LiveRecord();

	record.add(value({ "raw": 1, "step": 5 }));
	record.add(value({ "raw": 2, "step": 5 }));
	record.add(value({ "raw": 1, "step": 3 }));

	assert.deepEqual(record.drain().values.map((each) => each.value), ["1", "2"]);
});

test("stepping back into a statement told already: its values aren't told twice, and what's after them is", () => {
	const record = new LiveRecord();

	// A stop before statement 4 (kept), which tells three values; the run stops at the next statement before it tells
	// any, steps back to the first stop, and goes on from it — told again from where it was there.
	const atStop = record.told();

	for (const raw of [1, 2, 3]) {
		record.add(value({ "raw": raw, "step": 4 }));
	}

	record.resume(atStop);

	for (const raw of [1, 2, 3, 4]) {
		record.add(value({ "raw": raw, "step": 4 }));
	}

	record.add(value({ "raw": 5, "step": 5 }));

	assert.deepEqual(record.drain().values.map((each) => each.value), ["1", "2", "3", "4", "5"]);
});

test("a stop in the middle of a statement: going on from it, the statement's later values are new", () => {
	const record = new LiveRecord();

	record.add(value({ "raw": 1, "step": 7 }));

	const atStop = record.told(); // (a capability stop, say: inside statement 7)

	record.add(value({ "raw": 2, "step": 7 }));
	record.resume(atStop); // (stepped back to it, and on again)
	record.add(value({ "raw": 2, "step": 7 }));
	record.add(value({ "raw": 3, "step": 7 }));

	assert.deepEqual(record.drain().values.map((each) => each.value), ["1", "2", "3"]);
});
