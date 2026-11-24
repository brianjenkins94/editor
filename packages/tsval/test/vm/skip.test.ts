/**
 * A mutant (VMOptions.skip): one statement skipped wherever it would run, as if deleted, and counted — what a test
 * that notices its code broken fails on.
 *
 *   node --test test/vm/skip.test.ts
 */
import assert from "node:assert";
import { test } from "node:test";
import { createVM } from "../../src/interpret.ts";

const PROGRAM = `function total(items) {
	let sum = 0;
	for (const item of items) {
		sum += item;
	}
	return sum;
}
log(total([1, 2, 3]));
log(total([4]));
`;

function run(skip?: { "line": number; "character": number }): { "lines": unknown[]; "skipped": number } {
	const lines: unknown[] = [];
	const { vm } = createVM(PROGRAM, {
		"fileName": "/workspace/sum.js",
		"globals": {
			"log": (value: unknown) => { lines.push(value); }
		},
		...skip === undefined
			? {}
			: {
					"skip": { "file": "/workspace/sum.js", ...skip }
				}
	});

	vm.run();

	return { "lines": lines, "skipped": vm.skipped };
}

test("the statement starting at a line and character is skipped each time it would run, and counted", () => {
	assert.deepStrictEqual(run(), {
		"lines": [6, 4],
		"skipped": 0
	});
	assert.deepStrictEqual(run({ "line": 3, "character": 2 }), {
		"lines": [0, 0],
		"skipped": 4
	}, "`sum += item`, in the loop");
	assert.deepStrictEqual(run({ "line": 5, "character": 1 }), {
		"lines": [undefined, undefined],
		"skipped": 2
	}, "the return");
	assert.deepStrictEqual(run({ "line": 8, "character": 0 }), {
		"lines": [6],
		"skipped": 1
	}, "a top-level statement");
});

test("a place no statement starts at skips nothing", () => {
	assert.deepStrictEqual(run({ "line": 3, "character": 3 }), {
		"lines": [6, 4],
		"skipped": 0
	});
	assert.deepStrictEqual(run({ "line": 0, "character": 0 }), {
		"lines": [6, 4],
		"skipped": 0
	}, "a function declaration isn't a statement that runs");
});
