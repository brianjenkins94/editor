import type { EscapeEvent } from "../../src/vm.ts";
import assert from "node:assert";
import { test } from "node:test";
import ts from "typescript";
import { createVM } from "../../src/interpret.ts";

/** Run `code`, each escaping write as `function: what` (the function by its name), in order. */
function escapes(code: string): string[] {
	const seen: string[] = [];
	const { vm } = createVM(code, {
		"escapes": (event: EscapeEvent) => {
			const named = event.function as { "name"?: ts.Node; "parent"?: ts.Node };
			const name = named.name !== undefined ? named.name.getText() : named.parent !== undefined && ts.isVariableDeclaration(named.parent) ? named.parent.name.getText() : ts.isConstructorDeclaration(event.function) ? "constructor" : "(anonymous)";

			seen.push(`${name}: ${event.what}`);
		}
	});

	vm.run();

	return seen;
}

test("escapes is told nothing unless asked", () => {
	const { vm } = createVM("let a = 1; function f() { a = 2; } f(); a;");

	assert.strictEqual(vm.run(), 2);
});

test("a call's writes to what it made are its own; to what was there before, they escape", () => {
	assert.deepStrictEqual(escapes([
		"let total = 0;",
		"const seen = [];",
		"function add(a, b) { const out = { sum: a + b }; out.sum += 0; return out.sum; }",
		"function count() { total += 1; }",
		"function remember(x) { seen.push(x); }",
		"function sortIt(xs) { xs.sort(); }",
		"function sorted(xs) { const copy = xs.slice(); copy.sort(); return copy; }",
		"function counter() { let n = 0; return () => { n += 1; return n; }; }",
		"class Box { constructor(v) { this.v = v; } set(v) { this.v = v; } }",
		"add(1, 2); count(); remember(1); sortIt([3, 1]); sorted([2, 1]);",
		"const tick = counter(); tick();",
		"const box = new Box(1); box.set(2);",
		"total = 5;"
	].join("\n")), [
		"count: total",
		"remember: push",
		"sortIt: sort",
		"(anonymous): n", // counter's arrow, writing what counter made: escapes the arrow
		"set: v"
	]);
});

test("a write a callee makes is the callee's; a callee writing its caller's object escapes the callee", () => {
	assert.deepStrictEqual(escapes([
		"function fill(target) { target.done = true; }",
		"function build() { const made = {}; fill(made); return made; }",
		"build();"
	].join("\n")), ["fill: done"]);
});

test("a write escapes each call on the stack that began after what it wrote was made: a getter's write is its caller's too", () => {
	assert.deepStrictEqual(escapes([
		"const counter = { n: 0 };",
		"const box = { get value() { counter.n += 1; return 1; } };",
		"function read(o) { return o.value; }",
		"function outer() { const local = { n: 0 }; local.n = 1; return read(box); }",
		"outer();"
	].join("\n")), ["value: n", "read: n", "outer: n"]);
});
