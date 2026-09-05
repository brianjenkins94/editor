/**
 * Regression tests for interpreter findings of the post-S6 review (fork rebinding, suspension inside
 * sub-expressions, fork policy for accessors and class prototypes). Each test is the probe that
 * exposed the bug, kept so it can't come back.
 */
import { test } from "node:test";
import assert from "node:assert";
import { createVM, interpret } from "../../src/interpret.ts";
import type { Machine } from "../../src/vm.ts";

// --- #3: fork must rebind cloned closures to the forked VM ---

test("#3 fork: a host-invoked closure from the fork runs on the fork", () => {
	// (spies on the implementation's guest-call entry point — a `Machine` concern, not the host API)
	const vm = createVM("function mk(){ let c = 0; return { inc: () => ++c }; } const o = mk(); o;").vm as Machine;
	vm.run();
	const fork = vm.fork();
	let originalHits = 0;
	let forkHits = 0;
	const original = vm.callGuestFromHost.bind(vm);
	const forked = fork.callGuestFromHost.bind(fork);
	vm.callGuestFromHost = (...a) => (originalHits++, original(...a));
	fork.callGuestFromHost = (...a) => (forkHits++, forked(...a));
	(fork.rootScope.get("o") as { inc(): number }).inc();
	assert.deepStrictEqual({ originalHits, forkHits }, { originalHits: 0, forkHits: 1 });
});

// --- #4: await/yield inside a synchronous sub-evaluation must fail loud, not yield undefined ---

test("#4 await inside a computed object-literal key is modeled (the key is evaluated on the stepped stack)", async () => {
	const p = interpret(`(async () => { const o = { [await Promise.resolve("k")]: 1 }; return Object.keys(o)[0]; })()`) as Promise<unknown>;
	assert.strictEqual(await p, "k");
});

test("#4 await inside a destructuring default is modeled (stepped pattern frame), never a silent undefined", async () => {
	const p = interpret(`(async () => { const [x = await Promise.resolve(1)] = []; return x; })()`) as Promise<unknown>;
	assert.strictEqual(await p, 1);
});

test("#4 await inside a class computed key is modeled (keys evaluate on the stepped stack)", async () => {
	const p = interpret(`(async () => { class C { [await Promise.resolve("k")]() {} } return Object.getOwnPropertyNames(C.prototype); })()`) as Promise<unknown>;
	assert.deepStrictEqual(await p, ["constructor", "k"]);
});

test("#4 await inside a catch-clause pattern is modeled too (bound by a frame above the catch block)", async () => {
	const p = interpret(`(async () => { try { throw []; } catch ([a = await Promise.resolve(1)]) { return a; } })()`) as Promise<unknown>;
	assert.strictEqual(await p, 1);
});

// --- #7: fork policy — accessors rebind, class prototypes are shared consistently ---

test("#7 fork: object-literal accessors keep independent captured state", () => {
	const { vm } = createVM("function mk(){ let n = 1; return { get v(){ return n; }, set v(x){ n = x; } }; } const o = mk(); o;");
	vm.run();
	const fork = vm.fork();
	(vm.rootScope.get("o") as { v: number }).v = 99;
	assert.strictEqual((fork.rootScope.get("o") as { v: number }).v, 1);
});

test("#7 fork: a class prototype is shared, so a forked instance's proto is its constructor's prototype", () => {
	const { vm } = createVM("class A { m(){ return 1; } } const a = new A(); a;");
	vm.run();
	const fork = vm.fork();
	const A = fork.rootScope.get("A") as { prototype: object };
	const a = fork.rootScope.get("a") as object;
	assert.strictEqual(Object.getPrototypeOf(a), A.prototype);
});
