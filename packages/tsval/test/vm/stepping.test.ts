import assert from "node:assert";
import { test } from "node:test";
import { createVM } from "../../src/interpret.ts";

test("breakpoint by line: pause before the marked statement and inspect state", () => {
	const src = ["let total = 0;", "for (let i = 1; i <= 3; i++) {", "  total += i;", "}", "total;"].join("\n");
	const { vm } = createVM(src);

	vm.addBreakpointsByLine(3); // `total += i;`

	const seen: number[] = [];

	while (!vm.finished) {
		vm.runToBreakpoint();
		if (vm.finished) {
			break;
		}

		// We are paused at the top of `total += i;` — the loop variable is observable.
		const loc = vm.location();

		assert.strictEqual(loc?.line, 2, "breakpoint reports 0-based line 2 (source line 3)");
		seen.push(vm.frames.length);
	}

	// The breakpoint is hit once per loop iteration (3x).
	assert.strictEqual(seen.length, 3);
	assert.strictEqual(vm.completion, 6);
});

test("location + currentNode track the top frame", () => {
	const { vm } = createVM(`const a = 1;\nconst b = 2;\na + b;`);

	vm.stepStatement(); // enter the program, sit at the first statement
	assert.ok(vm.currentNode !== null);
	const loc = vm.location();

	assert.ok(loc !== null && loc.line === 0);
});

test("runUntil can pause on an operand-stack condition, then resume", () => {
	const { vm } = createVM(`const x = 6 * 7; x;`);

	vm.runUntil((machine) => machine.values.includes(42));
	assert.ok(!vm.finished, "stopped as soon as 42 was computed");
	assert.strictEqual(vm.run(), 42);
});

test("generator is a suspendable fiber: values pace through .next()", () => {
	// Driving a guest generator from a host loop exercises fiber suspend/resume.
	const { vm } = createVM(`function* count() { let n = 0; while (true) yield n++; } count();`);
	const gen = vm.run() as Iterator<number>;

	assert.deepStrictEqual([gen.next().value, gen.next().value, gen.next().value], [0, 1, 2]);
	assert.strictEqual(gen.next().done, false, "infinite generator never completes on its own");
});

test("snapshot of the step budget is observable and monotonic", () => {
	const { vm } = createVM(`function fib(n){ return n < 2 ? n : fib(n-1)+fib(n-2); } fib(8);`);

	assert.strictEqual(vm.steps, 0);
	vm.stepStatement();
	const mid = vm.steps;

	assert.ok(mid > 0);
	vm.run();
	assert.ok(vm.steps > mid, "step counter advanced to completion");
	assert.strictEqual(vm.completion, 21);
});
