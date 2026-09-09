import { test } from "node:test";
import assert from "node:assert";
import { createVM } from "../../src/interpret.ts";
import { syntaxKindName } from "../../src/frontend.ts";

const ACCEPTANCE = `const u = "https://x"; const n = 1 + 2; id(u, n)`;

test("acceptance: runs the snippet end to end, shim receives the values", () => {
	const received: unknown[][] = [];
	const id = (...args: unknown[]) => {
		received.push(args);
		return args;
	};
	const { vm } = createVM(ACCEPTANCE, { globals: { id } });
	const result = vm.run();

	assert.deepStrictEqual(received, [["https://x", 3]], "injected shim received the runtime values");
	assert.deepStrictEqual(result, ["https://x", 3], "completion value is the call result");
});

test("acceptance: single-steps through the snippet, stacks observable between steps", () => {
	const { vm } = createVM(ACCEPTANCE, { globals: { id: (...a: unknown[]) => a } });

	// stepStatement() advances statement-by-statement; the control stack is inspectable each time.
	const boundaries: string[] = [];
	let guard = 0;
	while (!vm.finished && guard++ < 100) {
		const top = vm.top;
		if (top) {
			const label = top.kind ?? syntaxKindName((top.node as { kind: number }).kind);
			boundaries.push(label);
			// Frames and values are plain, inspectable data structures.
			assert.ok(Array.isArray(vm.values));
			assert.ok(Array.isArray(vm.frames));
		}
		vm.stepStatement();
	}

	assert.ok(vm.finished, "machine reached completion via stepping");
	assert.deepStrictEqual(vm.completion, ["https://x", 3]);
	// We should have stopped at each of the three top-level statements.
	assert.deepStrictEqual(boundaries.slice(0, 4), ["SourceFile", "VariableStatement", "VariableStatement", "ExpressionStatement"]);
});

test("fine-grained step() fills the value stack for `1 + 2`", () => {
	const { vm } = createVM(`1 + 2`);
	const depths: number[] = [];
	while (!vm.finished) {
		depths.push(vm.values.length);
		vm.step();
	}
	// The operand stack grows to hold the two literals, then collapses to the sum.
	assert.ok(Math.max(...depths) >= 2, "operand stack held both operands");
	assert.strictEqual(vm.completion, 3);
});

test("deep guest recursion runs on the explicit stack (no host-stack overflow)", () => {
	const { vm } = createVM(`function down(n) { return n === 0 ? 0 : down(n - 1); } down(20000)`);
	assert.strictEqual(vm.run(), 0);
});

test("runUntil stops on a predicate", () => {
	const { vm } = createVM(`const a = 1; const b = 2; a + b`);
	vm.runUntil((m) => m.completion === undefined && m.values.length > 0);
	assert.ok(!vm.finished, "stopped before completion");
	vm.run();
	assert.strictEqual(vm.completion, 3);
});
