import type { VM } from "../../src/vm.ts";
import assert from "node:assert";
import { test } from "node:test";
import { createVM } from "../../src/interpret.ts";

// Reading guest values back out of a scope is inherently untyped; keep the tests terse.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const get = (m: VM, name: string): any => m.rootScope.get(name);

test("fork: guest objects and arrays are cloned (mutation stays local)", () => {
	const { vm } = createVM("const box = { n: 1 }; const list = [10]; box.n;");

	vm.run();
	const fork = vm.fork();

	get(vm, "box").n = 99;
	get(vm, "list").push(20);

	assert.strictEqual(get(fork, "box").n, 1, "forked object is independent");
	assert.strictEqual(get(fork, "list").length, 1, "forked array is independent");
});

test("fork: host shims are shared, not cloned (identity preserved)", () => {
	const shim = (...a: unknown[]) => a;
	const { vm } = createVM("record; 0;", { "globals": { "record": shim } });

	vm.run();
	const fork = vm.fork();

	assert.strictEqual(get(vm, "record"), shim);
	assert.strictEqual(get(fork, "record"), shim, "shim shared across the fork");
});

test("fork: a mid-execution fork continues independently (control stack cloned)", () => {
	const { vm } = createVM("let sum = 0; let i = 0; while (i < 10) { sum += i; i = i + 1; } sum;");

	vm.runUntil((m) => {
		try {
			return m.rootScope.get("i") === 3;
		} catch {
			return false;
		}
	});
	const fork = vm.fork();

	vm.run(); // original loop runs to completion: 0+1+…+9
	fork.rootScope.set("i", 8); // tamper only the fork's state
	fork.run(); // resumes the cloned loop frame: (0+1+2) + (8+9)

	assert.strictEqual(vm.completion, 45);
	assert.strictEqual(fork.completion, 20);
});

test("fork: closures capture independent state", () => {
	const { vm } = createVM("function mk(){ let c = 0; return { inc: () => ++c, get: () => c }; } const o = mk(); o.inc(); o;");

	vm.run();
	const fork = vm.fork();

	get(vm, "o").inc(); // original: c -> 2

	assert.strictEqual(get(vm, "o").get(), 2);
	assert.strictEqual(get(fork, "o").get(), 1, "forked closure kept its own captured variable");
});

test("fork: class instances survive (shared prototype + constructor, cloned data)", () => {
	const { vm } = createVM("class A { constructor(v){ this.v = v; } get2(){ return this.v * 2; } } const a = new A(5); a;");

	vm.run();
	const fork = vm.fork();

	const A = get(fork, "A");
	const a = get(fork, "a");

	assert.ok(a instanceof A, "instanceof works across the fork");
	assert.strictEqual(a.get2(), 10, "methods still callable");

	get(vm, "a").v = 99;
	assert.strictEqual(get(fork, "a").v, 5, "instance data is independent");
});

test("fork: forks do not share the step budget or completion", () => {
	const { vm } = createVM("let x = 1; x = x + 1; x;");

	vm.runUntil((m) => {
		try {
			return m.rootScope.get("x") === 1;
		} catch {
			return false;
		}
	});
	const fork = vm.fork();
	const stepsAtFork = vm.steps;

	vm.run();
	assert.strictEqual(fork.steps, stepsAtFork, "fork keeps the step count at the fork point");
	assert.ok(vm.steps > stepsAtFork);
});
