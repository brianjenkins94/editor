import type { VM } from "../../src/vm.ts";
import assert from "node:assert";
import { test } from "node:test";
import { createVM } from "../../src/interpret.ts";

/** Each statement that ran as `line: text → count`, in source order (1-based lines, first line of the statement). */
function counts(vm: VM): string[] {
	const sourceFile = vm.sourceFile!;
	const { statements, counts: ran } = vm.coverage!.get(sourceFile)!;

	return statements
		.map((node, index) => [node, ran[index]] as const)
		.filter(([, count]) => count > 0)
		.map(([node, count]) => `${sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1}: ${node.getText(sourceFile).split("\n")[0]} → ${count}`);
}

/** How many statement starts `vm` has counted, over every file. */
function total(vm: VM): number {
	return [...vm.coverage!.values()].reduce((sum, file) => sum + file.counts.reduce((a, b) => a + b, 0), 0);
}

test("coverage is off unless asked for", () => {
	const { vm } = createVM("const a = 1;");

	vm.run();
	assert.strictEqual(vm.coverage, undefined);
});

// A block's statements run without the block taking a step of its own, and a function declaration is hoisted rather
// than run: neither is ever counted, so a coverage report shouldn't expect them to be.
test("coverage counts each statement once per execution, and what never ran as 0", () => {
	const { vm } = createVM([
		"let total = 0;",
		"for (let i = 0; i < 3; i++) {",
		"\ttotal += i;",
		"}",
		"if (total > 100) {",
		"\ttotal = 0;",
		"} else {",
		"\ttotal += 1;",
		"}",
		"function double(n: number): number {",
		"\treturn n * 2;",
		"}",
		"double(1); double(2);"
	].join("\n"), { "coverage": true });

	vm.run();
	assert.deepStrictEqual(counts(vm), [
		"1: let total = 0; → 1",
		"2: for (let i = 0; i < 3; i++) { → 1",
		"3: total += i; → 3",
		"5: if (total > 100) { → 1",
		"8: total += 1; → 1",
		"11: return n * 2; → 2",
		"13: double(1); → 1",
		"13: double(2); → 1"
	]);

	const { statements, counts: ran } = vm.coverage!.get(vm.sourceFile!)!;

	assert.strictEqual(ran[statements.findIndex((node) => node.getText() === "total = 0;")], 0, "the arm that never ran: there, at 0");
	assert.strictEqual(total(vm), 11, "(and the statement clock moved once for each)");
	assert.strictEqual(vm.statements, 11);
});

test("a fork's coverage is its own timeline's", () => {
	const { vm } = createVM("let n = 0;\nn += 1;\nn += 2;", { "coverage": true });

	vm.stepStatement();

	const fork = vm.fork();

	vm.run();
	assert.strictEqual(total(fork) < total(vm), true, "the fork hasn't run the later statements");
	fork.run();
	assert.deepStrictEqual(counts(fork), counts(vm), "run to the end, the fork covers the same statements once each");
});
