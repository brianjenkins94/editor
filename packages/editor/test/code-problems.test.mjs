// A change's problems against HEAD (workbench/code-problems.ts): the same problem is the same wherever it moved.
import assert from "node:assert/strict";
import { test } from "node:test";
import { problemsDelta } from "../workbench/code-problems.ts";

const problem = (file, line, code, message, source = "ts") => ({ "file": file, "line": line, "column": 1, "source": source, "code": code, "severity": "error", "message": message });

test("a problem that moved is unchanged; one that's new is added; one that's gone is cleared", () => {
	const head = [problem("a.ts", 3, 2322, "Type 'string' is not assignable to type 'number'."), problem("a.ts", 9, 2304, "Cannot find name 'gone'.")];
	const now = [problem("a.ts", 5, 2322, "Type 'string' is not assignable to type 'number'."), problem("b.ts", 1, 2339, "Property 'x' does not exist on type '{}'.")];

	const { added, cleared, unchanged } = problemsDelta(head, now);

	assert.deepEqual(added.map(({ file, code }) => [file, code]), [["b.ts", 2339]]);
	assert.deepEqual(cleared.map(({ file, line, code }) => [file, line, code]), [["a.ts", 9, 2304]], "a cleared one, where HEAD had it");
	assert.equal(unchanged, 1);
});

test("as multisets: a second copy of a problem is added, and the source tells TypeScript's from ESLint's", () => {
	const same = problem("a.ts", 2, "no-var", "Unexpected var, use let or const instead.", "eslint");
	const { added, cleared, unchanged } = problemsDelta([same], [same, { ...same, "line": 7 }, { ...same, "source": "ts" }]);

	assert.deepEqual(added.map(({ line, source }) => [line, source]), [[7, "eslint"], [2, "ts"]]);
	assert.deepEqual(cleared, []);
	assert.equal(unchanged, 1);
});
