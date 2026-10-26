import type { EscapeEvent, VMOptions } from "../../src/vm.ts";
import assert from "node:assert";
import { test } from "node:test";
import ts from "typescript";
import type { VM } from "../../src/vm.ts";
import { runToEnd } from "../../src/explore.ts";
import { createVM } from "../../src/interpret.ts";

/** A function's name, as these tests say it. */
function nameOf(fn: ts.Node): string {
	const named = fn as { "name"?: ts.Node; "parent"?: ts.Node };

	return named.name !== undefined ? named.name.getText() : named.parent !== undefined && ts.isVariableDeclaration(named.parent) ? named.parent.name.getText() : ts.isConstructorDeclaration(fn) ? "constructor" : "(anonymous)";
}

/** Run `code`, each escaping write as `function: what` (the function by its name), in order — any other kind of
 *  impurity as `function: kind what`. */
function escapes(code: string, options: Partial<VMOptions> = {}): string[] {
	const seen: string[] = [];
	const { vm } = createVM(code, {
		...options,
		"escapes": (event: EscapeEvent) => {
			seen.push(`${nameOf(event.function)}: ${event.kind === "write" ? "" : event.kind + " "}${event.what}`);
		}
	});

	vm.run();

	return seen;
}

/** `escapes`, on an event loop: run to its end. */
async function escapesOnLoop(code: string): Promise<string[]> {
	const seen: string[] = [];
	const { vm } = createVM(code, { "eventLoop": { "pace": "fast" }, "escapes": (event: EscapeEvent) => { seen.push(`${nameOf(event.function)}: ${event.kind === "write" ? "" : event.kind + " "}${event.what}`); } });

	await runToEnd(vm);

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

test("reading the clock or random numbers is nondeterministic; setting a timer, an effect — on the event loop's too", async () => {
	const code = [
		"function stamp() { return Date.now(); }",
		"function roll() { return Math.random(); }",
		"function today() { return new Date(); }",
		"function parsed() { return new Date(0).getTime() + Math.max(1, 2); }",
		"function later(f) { setTimeout(f, 1); }",
		"stamp(); roll(); today(); parsed(); later(() => {});"
	].join("\n");
	const expected = ["stamp: nondeterministic Date.now", "roll: nondeterministic Math.random", "today: nondeterministic Date", "later: effect setTimeout"];

	assert.deepStrictEqual(escapes(code, { "globals": { "setTimeout": setTimeout } }), expected);
	assert.deepStrictEqual(await escapesOnLoop(code), expected);
});

test("a host function that isn't a built-in is unwatched, unless the embedder watches it and tells its effects", () => {
	const pkg = { "join": (a: string, b: string): string => a + "/" + b };
	const log = (): void => { machine?.impure("effect", "console.log"); };
	let machine: VM | undefined;
	const seen: string[] = [];
	const { vm } = createVM("function where(a) { return pkg.join(a, 'b'); }\nfunction say(a) { log(a); return [a].map(String).join(); }\nwhere('a'); say('x');", {
		"globals": { "pkg": pkg, "log": log },
		"watches": new WeakSet([log]),
		"escapes": (event: EscapeEvent) => { seen.push(`${nameOf(event.function)}: ${event.kind} ${event.what}`); }
	});

	machine = vm;
	vm.run();
	assert.deepStrictEqual(seen, ["where: unwatched join", "say: effect console.log"]);
});

test("more built-ins write what they're given: Reflect's, a typed array's, a Date's setters", () => {
	assert.deepStrictEqual(escapes([
		"function put(o) { Reflect.set(o, 'a', 1); }",
		"function zero(xs) { xs.fill(0); }",
		"function noon(d) { d.setHours(12); }",
		"function fresh() { const d = new Date(0); d.setHours(12); return d; }",
		"put({}); zero(new Uint8Array(2)); noon(new Date(0)); fresh();"
	].join("\n")), ["put: Reflect.set", "zero: fill", "noon: setHours"]);
});

test("called is told each call of a guest function", () => {
	const counts = new Map<string, number>();
	const { vm } = createVM("function f(x) { return x + 1; }\nconst g = (x) => f(x) * 2;\nfor (let i = 0; i < 3; i += 1) { g(i); }", {
		"called": (fn) => { counts.set(nameOf(fn), (counts.get(nameOf(fn)) ?? 0) + 1); }
	});

	vm.run();
	assert.deepStrictEqual(Object.fromEntries(counts), { "g": 3, "f": 3 });
});
