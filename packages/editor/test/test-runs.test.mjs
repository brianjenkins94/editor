/**
 * A test that ran slower than it typically does (workbench/test-runs.ts `slowerOf`): by its statements, where they're
 * counted, against the median of the earlier runs it passed in; else by its time, once there are enough runs to go by.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { slowerOf } from "../workbench/test-runs.ts";

const ID = "a.test.mjs › adds";

/** An earlier run of a.test.mjs in which `adds` came out `outcome`, with `ms` and `statements`. */
function run(ms, statements, outcome = "pass") {
	return {
		"file": "a.test.mjs",
		"at": "",
		"ms": ms,
		"exitCode": 0,
		"effects": [],
		"tests": [
			{
				"id": ID,
				"outcome": outcome,
				"ms": ms,
				...statements === undefined
					? {}
					: { "statements": statements }
			}
		]
	};
}

test("by its statements, against the median of its earlier passes: over the threshold it's slower, by how much", () => {
	const earlier = [
		run(10, 100),
		run(50, 100),
		run(12, 120)
	];

	assert.deepEqual(slowerOf(earlier, ID, { "ms": 10, "statements": 150 }, 25), { "by": 50, "measure": "statements", "typical": 100 });
	assert.equal(slowerOf(earlier, ID, { "ms": 500, "statements": 120 }, 25), undefined, "its work the same: a slow time beside other runs isn't its own");
	assert.equal(slowerOf(earlier, ID, { "statements": 150 }, 60), undefined, "within a looser threshold");
});

test("a run it failed isn't what it typically does; with no statements counted, its time, once it has enough runs", () => {
	assert.deepEqual(slowerOf([
		run(10, 100),
		run(10, 900, "fail")
	], ID, { "statements": 200 }, 25), { "by": 100, "measure": "statements", "typical": 100 });
	assert.equal(slowerOf([
		run(10),
		run(10)
	], ID, { "ms": 100 }, 25), undefined, "two timed runs: too few to go by");
	assert.deepEqual(slowerOf([
		run(10),
		run(12),
		run(14)
	], ID, { "ms": 30 }, 25), { "by": 150, "measure": "time", "typical": 12 });
	assert.equal(slowerOf([], ID, { "ms": 30, "statements": 1 }, 25), undefined, "nothing earlier");
});
