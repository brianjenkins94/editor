import assert from "node:assert";
import { test } from "node:test";
import ts from "typescript";
import { syntaxKindName } from "../../src/frontend.ts";
import { createVM } from "../../src/interpret.ts";

const ACCEPTANCE = `const u = "https://x"; const n = 1 + 2; id(u, n)`;

test("acceptance: runs the snippet end to end, shim receives the values", () => {
	const received: unknown[][] = [];
	const id = (...args: unknown[]) => {
		received.push(args);

		return args;
	};

	const { vm } = createVM(ACCEPTANCE, { "globals": { "id": id } });
	const result = vm.run();

	assert.deepStrictEqual(received, [["https://x", 3]], "injected shim received the runtime values");
	assert.deepStrictEqual(result, ["https://x", 3], "completion value is the call result");
});

test("acceptance: single-steps through the snippet, stacks observable between steps", () => {
	const { vm } = createVM(ACCEPTANCE, { "globals": { "id": (...args: unknown[]) => args } });

	// stepStatement() advances statement-by-statement; the control stack is inspectable each time.
	const boundaries: string[] = [];
	let guard = 0;

	while (!vm.finished && guard < 100) {
		guard += 1;
		const { top } = vm;

		if (top) {
			const label = top.kind ?? syntaxKindName((top.node as { "kind": number }).kind);

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

test("fine-grained step() fills the value stack for `[1][0] + [2][0]`", () => {
	const { vm } = createVM(`[1][0] + [2][0]`);
	const depths: number[] = [];

	while (!vm.finished) {
		depths.push(vm.values.length);
		vm.step();
	}

	// The operand stack grows to hold the two operands, then collapses to the sum.
	assert.ok(Math.max(...depths) >= 2, "operand stack held both operands");
	assert.strictEqual(vm.completion, 3);
});

test("a leaf operand costs no step of its own: its parent reads it", () => {
	const { vm } = createVM(`const a = 1; const b = "two"; [b, true, null, a + 2, f(a), { a, b: a }]; function f(x) { return x; }`);
	const leaves = new Set([ts.SyntaxKind.Identifier, ts.SyntaxKind.NumericLiteral, ts.SyntaxKind.StringLiteral, ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.NullKeyword]);

	while (!vm.finished) {
		const node = (vm.top as { "node"?: ts.Node | null } | undefined)?.node;

		assert.ok(node === undefined || node === null || !leaves.has(node.kind), `no step on a leaf (${node?.getText()})`);
		vm.step();
	}

	// (an array's leading leaves: one after a non-leaf operand evaluates after it, on a frame of its own)
	assert.deepStrictEqual(vm.completion, ["two", true, null, 3, 1, { "a": 1, "b": 1 }]);
});

test("a simple tree — leaves under plain operators — is evaluated in its parent's step, converting as JS does", () => {
	const program = `const log = []; const a = { valueOf() { log.push("a"); return 1; } }; const b = { valueOf() { log.push("b"); return 2; } };
const r = a + b * -b - (~a > !b); [r, log.join()]`;
	// eslint-disable-next-line no-eval -- the native result to compare with
	const native = (0, eval)(`(() => { ${program.replace("[r, log.join()]", "return [r, log.join()];")} })()`);

	assert.deepStrictEqual(createVM(program).vm.run(), native, "the same value and the same valueOf calls, in order");

	const { vm } = createVM(`let even = 0; for (let n = 0; n < 4; n += 1) { if (n % 2 === 0) { even += 1; } } even`);

	while (!vm.finished) {
		const node = (vm.top as { "node"?: ts.Node | null } | undefined)?.node;

		assert.ok(node?.kind !== ts.SyntaxKind.BinaryExpression || (node as ts.BinaryExpression).operatorToken.kind === ts.SyntaxKind.PlusEqualsToken, `no step on a simple tree (${node?.getText()})`);
		vm.step();
	}

	assert.strictEqual(vm.completion, 2);
});

test("an assignment to a name, evaluated in its parent's step, stores, traces and throws as its frames did", () => {
	const binds: string[] = [];
	const { vm } = createVM(`let x = 0; x += 2; x++; ++x; x = x * 3; let s = "a"; s += "b"; let b = 1n; b++; [x, s, b]`, { "trace": (event) => {
		if (event.kind === "bind") {
			binds.push(`${event.name}=${String(event.value)}`);
		}
	} });

	assert.deepStrictEqual(vm.run(), [12, "ab", 2n]);
	assert.deepStrictEqual(binds, ["x=0", "x=2", "x=3", "x=4", "x=12", "s=a", "s=ab", "b=1", "b=2"]);

	for (const [program, thrown] of [[`const c = 1; c += 1;`, "TypeError"], [`y += 1; let y = 0;`, "ReferenceError"], [`undeclared = 1;`, "ReferenceError"], [`let u; u = nope + 1;`, "ReferenceError"]]) {
		assert.strictEqual(createVM(`try { ${program} } catch (error) { error.constructor.name }`).vm.run(), thrown, program);
	}
});

test("leaves read in place keep evaluation order, and a throwing one is caught", () => {
	assert.strictEqual(createVM(`let x = 1; x + (x = 2)`).vm.run(), 3, "the left read before the right assigns");
	assert.strictEqual(createVM(`let x = 1; (x = 2) + x`).vm.run(), 4, "the right read after the left assigns");
	assert.strictEqual(createVM(`let x = 1; [x, x = 5, x].join()`).vm.run(), "1,5,5");
	assert.strictEqual(createVM(`try { 1 + missing; } catch (error) { error instanceof ReferenceError; }`).vm.run(), true);
	assert.strictEqual(createVM(`try { f(early); let early = 1; } catch (error) { error instanceof ReferenceError; } function f() {}`).vm.run(), true, "a binding in its TDZ throws as it did");
});

test("deep guest recursion runs on the explicit stack (no host-stack overflow)", () => {
	const { vm } = createVM(`function down(n) { return n === 0 ? 0 : down(n - 1); } down(20000)`);

	assert.strictEqual(vm.run(), 0);
});

test("runUntil stops on a predicate", () => {
	const { vm } = createVM(`const a = 1; const b = 2; [a][0] + b`);

	vm.runUntil((machine) => machine.completion === undefined && machine.values.length > 0);
	assert.ok(!vm.finished, "stopped before completion");
	vm.run();
	assert.strictEqual(vm.completion, 3);
});
