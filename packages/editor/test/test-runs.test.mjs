/**
 * A test that ran slower than it typically does (workbench/test-runs.ts `slowerOf`): by its statements, where they're
 * counted, against the median of the earlier runs it passed in; else by its time, once there are enough runs to go by.
 * And which tests a change selects (`selectionOf`, `changedLines`): by the lines it changed and what each test last ran,
 * and why each changed file selected what it did. And which test files can't run at once (`contentionsOf`): one writes
 * what another reads or writes, over every run kept, said by the tests that did it. And how much of each code file the
 * tests ran (`statementsOf`, `coverageOf`): by statements, over each test file's last run.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { changedLines, contentionsOf, coverageOf, kindOf, selectionOf, slowerOf, statementsOf } from "../workbench/test-runs.ts";

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

test("a test file's kind is what its imports say, not what its text mentions: a test folder's helper isn't a test", () => {
	assert.equal(kindOf("import { test } from \"node:test\";\n"), "unit");
	assert.equal(kindOf("import { expect, test } from \"@playwright/test\";\n"), "UI spec");
	assert.equal(kindOf("import { test } from \"node:test\";\nimport { startSession } from \"./architecture-harness.mjs\";\n"), "browser suite");
	assert.equal(kindOf("export const fixture = \"import { test } from 'node:test'\";\n"), "not a test");
});

/** A made call to `capability` on `resource`, as a run keeps it. */
const touch = (capability, resource, decided = "policy") => ({ "capability": capability, "resource": resource, "how": "made", "calls": 1, "decided": decided });

/** A run of `file`: `tests` as [title, effects], and the file's own effects besides. */
const ranWith = (file, tests, effects = []) => ({
	"file": file,
	"at": "",
	"ms": 1,
	"exitCode": 0,
	"tests": tests.map(([title, its]) => ({ "id": `${file} › ${title}`, "outcome": "pass", "effects": its })),
	"effects": [...effects, ...tests.flatMap(([, its]) => its)]
});

test("contentions: a write against another file's write or read, by the tests that did it, over every run kept", () => {
	const contentions = contentionsOf([
		ranWith("one.test.mjs", [["writes", [touch("fs:write", "/workspace/shared.txt"), touch("fs:read", "/workspace/shared.txt")]]]),
		// (it wrote once, then didn't: still can't run beside the others)
		ranWith("two.test.mjs", [["writes too", [touch("fs:write", "/workspace/shared.txt")]]]),
		ranWith("two.test.mjs", [["writes too", []]]),
		// (the file's own code, outside any test)
		ranWith("three.test.mjs", [], [touch("fs:read", "/workspace/shared.txt")]),
		// (only reads: no contention between two readers)
		ranWith("four.test.mjs", [["reads", [touch("fs:read", "/workspace/data.json")]]]),
		ranWith("five.test.mjs", [["reads", [touch("fs:read", "/workspace/data.json")]]])
	]);

	assert.deepEqual(contentions.get("one.test.mjs"), [
		{ "test": "one.test.mjs › writes", "touches": "writes", "resource": "/workspace/shared.txt", "other": "three.test.mjs", "otherTouches": "reads" },
		{ "test": "one.test.mjs › writes", "touches": "writes", "resource": "/workspace/shared.txt", "other": "two.test.mjs", "otherTest": "two.test.mjs › writes too", "otherTouches": "writes" }
	]);
	assert.deepEqual(contentions.get("three.test.mjs")?.map((each) => [each.test, each.touches, each.other]), [
		[undefined, "reads", "one.test.mjs"],
		[undefined, "reads", "two.test.mjs"]
	]);
	assert.equal(contentions.has("four.test.mjs"), false);
	assert.equal(contentions.has("five.test.mjs"), false);
});

test("contentions: a write the world never saw — denied, given back from a recording, into the run's own layer — contends with nothing", () => {
	const contentions = contentionsOf([
		ranWith("one.test.mjs", [["writes", [touch("fs:write", "/workspace/a.txt", "layer"), { ...touch("fs:write", "/workspace/b.txt"), "how": "denied" }, { ...touch("fs:write", "/workspace/c.txt"), "how": "given" }]]]),
		ranWith("two.test.mjs", [["writes", [touch("fs:write", "/workspace/a.txt"), touch("fs:write", "/workspace/b.txt"), touch("fs:write", "/workspace/c.txt")]]])
	]);

	assert.equal(contentions.size, 0);
});

/** A statement at `line` (from 0) that ran `count` times, as a coverage event has it. */
const statement = (line, count) => ({ "start": [line, 1], "end": [line, 9], "count": count });

test("a run's statements: each code file it loaded, ran and not — not the test's own, nor what's installed", () => {
	assert.deepEqual(statementsOf({
		"file": "/workspace/a.test.mjs",
		"statements": [statement(0, 1)],
		"sites": [],
		"files": [
			{ "file": "/workspace/math.mjs", "statements": [statement(0, 1), statement(1, 2), statement(4, 0)], "sites": [] },
			{ "file": "/workspace/node_modules/x/index.js", "statements": [statement(0, 1)], "sites": [] },
			{ "file": "/workspace/data.json", "statements": [statement(0, 1)], "sites": [] }
		]
	}), { "math.mjs": { "ran": [[0, 1], [1, 1]], "not": [[4, 1]] } });
});

test("coverage: a statement any test file's run ran, of a code file's statements as its latest run saw them, and which ran any", () => {
	const coverage = coverageOf([
		{ "at": "2026-11-21T10:00:00Z", "file": "a.test.mjs", "files": { "math.mjs": { "ran": [[0, 1], [1, 1]], "not": [[4, 1], [5, 1]] } } },
		// (later, math.mjs edited: what the earlier run ran at a place that's no longer a statement doesn't count)
		{ "at": "2026-11-21T11:00:00Z", "file": "b.test.mjs", "files": { "math.mjs": { "ran": [[4, 1]], "not": [[0, 1], [6, 1]] }, "other.mjs": { "ran": [], "not": [[0, 1]] } } },
		// (and a run kept before it said whose it was: counted, by no file)
		{ "at": "2026-11-21T09:00:00Z", "files": { "other.mjs": { "ran": [[0, 1]], "not": [] } } }
	]);

	assert.deepEqual(Object.fromEntries(coverage), {
		"math.mjs": { "statements": 3, "ran": 2, "by": ["a.test.mjs", "b.test.mjs"] },
		"other.mjs": { "statements": 1, "ran": 1, "by": [] }
	});
});
