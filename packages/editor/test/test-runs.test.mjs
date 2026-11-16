/**
 * A test that ran slower than it typically does (workbench/test-runs.ts `slowerOf`): by its statements, where they're
 * counted, against the median of the earlier runs it passed in; else by its time, once there are enough runs to go by.
 * And which tests a change selects (`selectionOf`, `changedLines`): by the lines it changed and what each test last ran,
 * and why each changed file selected what it did.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { changedLines, selectionOf, slowerOf } from "../workbench/test-runs.ts";

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

const MATH = "export function add(one, other) {\n\treturn one + other;\n}\n\nexport function times(one, other) {\n\treturn one * other;\n}\n";
const isTest = (path) => path.endsWith(".test.mjs");
// (what each test last ran, from 0: add's body, and times'; both ran the declarations)
const REACH = {
	"add.test.mjs › adds": { "add.test.mjs": [[0, 6]], "math.mjs": [[0, 1], [4, 4]] },
	"times.test.mjs › times": { "times.test.mjs": [[0, 6]], "math.mjs": [[0, 0], [4, 5]] }
};

test("a change's lines, from 0, on both sides: what it replaced and what it put there, or either side of an insertion", () => {
	assert.deepEqual(changedLines(MATH, MATH.replace("one * other", "other * one")), [[5, 5], [5, 5]]);
	assert.deepEqual(changedLines(MATH, MATH.replace("\n\nexport function times", "\n\n// times\nexport function times")), [[3, 4], [4, 4]]);
	assert.deepEqual(changedLines(MATH, MATH), []);
});

test("a change selects the tests that ran its lines, not every test that ran its file", () => {
	const { tests, why } = selectionOf([{ "path": "math.mjs", "lines": [[5, 5]] }], REACH, isTest);

	assert.deepEqual([...tests.keys()], ["times.test.mjs › times"]);
	assert.deepEqual(why, [{ "path": "math.mjs", "why": "lines run", "tests": 1 }]);
});

test("all of a file, when its lines aren't known (git hasn't it yet)", () => {
	assert.deepEqual([...selectionOf([{ "path": "math.mjs" }], REACH, isTest).tests.keys()], ["add.test.mjs › adds", "times.test.mjs › times"]);
});

test("a change nothing here checks says so: lines no test ran, code no test runs; config and docs say what they are", () => {
	const { tests, why } = selectionOf([
		{ "path": "math.mjs", "lines": [[8, 9]] },
		{ "path": "unused.ts", "lines": [[0, 0]] },
		{ "path": "packages/editor/package.json" },
		{ "path": "README.md" },
		{ "path": "times.test.mjs" }
	], REACH, isTest);

	assert.deepEqual([...tests.keys()], ["times.test.mjs › times"]);
	assert.deepEqual(why.map((each) => each.why), ["lines not run", "not run", "config", "not code", "test"]);
});
