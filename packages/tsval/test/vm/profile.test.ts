import assert from "node:assert";
import { test } from "node:test";
import { runToEnd } from "../../src/explore.ts";
import { createVM } from "../../src/interpret.ts";

/** A program's profile, by its top-level statements' first lines (1-based). */
async function profileOf(source: string): Promise<Map<number, { "statements": number; "waited": number; "first": number }>> {
	const { vm, sourceFile } = createVM(source, { "profile": true, "eventLoop": { "now": 0, "pace": "fast" }, "globals": { "log": () => undefined } });

	await runToEnd(vm);

	return new Map([...vm.profile!].map(([statement, entry]) => [sourceFile.getLineAndCharacterOfPosition(statement.getStart(sourceFile)).line + 1, entry]));
}

test("profile: each top-level statement's statements run, by where the code is — a function's own, wherever it's called from", async () => {
	const profile = await profileOf([
		"function work(n) {",
		"  let total = 0;",
		"  for (let i = 0; i < n; i += 1) total += i;",
		"  return total;",
		"}",
		"const small = 1;",
		"log(work(200));",
		""
	].join("\n"));

	assert.ok(profile.get(1)!.statements > profile.get(7)!.statements * 10, "the loop's work is the function's, not the call's");
	assert.ok(profile.get(6)!.statements < 10);
	assert.ok(profile.get(6)!.first < profile.get(7)!.first, "first run, in order (a function declaration's is its hoisting, at the start)");
});

test("profile: a timer's wait is the statement whose code it runs — on the virtual clock, the same every run", async () => {
	const source = ["const start = Date.now();", "setTimeout(() => log(Date.now() - start), 500);", "setTimeout(() => log('later'), 800);", ""].join("\n");
	const [first, second] = [await profileOf(source), await profileOf(source)];

	assert.strictEqual(first.get(2)!.waited, 500);
	assert.strictEqual(first.get(3)!.waited, 300, "the clock was at 500 already");
	assert.strictEqual(first.get(1)!.waited, 0);
	assert.deepStrictEqual([...first], [...second], "deterministic");
});

test("profile: in the order the code first ran — a function's declaration where it stands, a concise callback's waits its own", async () => {
	const profile = await profileOf(["let total = 0;", "for (let i = 0; i < 30; i += 1) total += i;", "function square(n) {", "\treturn n * n;", "}", "void setTimeout(() => log(square(total)), 250);", ""].join("\n"));
	const order = [...profile].sort(([, a], [, b]) => a.first - b.first).map(([line]) => line);

	assert.deepStrictEqual(order, [1, 2, 3, 6], "the declaration's step, between the loop and the timer");
	assert.strictEqual(profile.get(6)!.waited, 250, "the timer's wait, to the callback's own statement (`() => …` stands for one)");
	assert.ok(profile.get(3)!.statements >= 2, "square's declaration and its body's `return`");
});

test("profile: a fork carries its own copy", async () => {
	const { vm } = createVM("let n = 0;\nfor (let i = 0; i < 50; i += 1) n += i;\nlog(n);\n", { "profile": true, "eventLoop": { "pace": "fast" }, "globals": { "log": () => undefined } });

	vm.addBreakpointsByLine(3);
	vm.runToBreakpoint();

	const fork = vm.fork();
	const [before] = [...vm.profile!.values()].map((entry) => entry.statements);

	await runToEnd(fork);
	assert.strictEqual([...vm.profile!.values()][0]!.statements, before, "the original's untouched");
	assert.ok(fork.profile!.size >= vm.profile!.size);
});
