/**
 * The host-boundary seams a sandboxing host builds on (a capability canary lives in its own repo):
 * `hostGuard.sanitize` sees every host→guest value crossing, `hostGuard.beforeCall` vets every host
 * callable the guest invokes, `onAsyncFiber` is told about every async invocation, and
 * `resolveModule` is the import seam. Tested directly, at the interpreter's level.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { interpret, interpretAsync, createVM } from "../../src/index.ts";

test("hostGuard.sanitize sees every property read that crosses from the host, including intrinsic reflection", () => {
	const seen: unknown[] = [];
	const sanitize = (value: unknown): unknown => {
		seen.push(value);
		return value === Function ? "not the real Function" : value;
	};
	const result = interpret(`[].constructor.constructor`, { hostGuard: { sanitize } });
	assert.equal(result, "not the real Function");
	assert.ok(seen.includes(Array), "the first read (Array) crossed the guard");
});

test("hostGuard.sanitize applies to values a host function returns and to awaited values", async () => {
	const sanitize = (value: unknown): unknown => (typeof value === "number" ? value * 10 : value);
	assert.equal(interpret(`host()`, { globals: { host: () => 4 }, hostGuard: { sanitize } }), 40);
	assert.equal(await interpretAsync(`(async () => await Promise.resolve(5))()`, { hostGuard: { sanitize } }), 50);
});

test("hostGuard.beforeCall vets every host callable, with the receiver and call/construct kind", () => {
	const calls: string[] = [];
	const beforeCall = (callee: (...a: unknown[]) => unknown, thisArg: unknown, isConstruct: boolean) => {
		calls.push(`${callee.name}:${isConstruct ? "new" : "call"}:${thisArg === undefined ? "-" : typeof thisArg}`);
		return callee.name === "blocked" ? () => "replaced" : callee;
	};
	const globals = { blocked: function blocked() { return "ran"; }, o: { m: function m() { return 1; } } };
	assert.deepEqual(interpret(`[blocked(), o.m(), new Date(0).getTime()]`, { globals, hostGuard: { beforeCall } }), ["replaced", 1, 0]);
	assert.deepEqual(calls, ["blocked:call:-", "m:call:object", "Date:new:-", "getTime:call:object"]);
});

test("guest→guest calls never pass through beforeCall (only host callables do)", () => {
	let hostCalls = 0;
	const beforeCall = (callee: (...a: unknown[]) => unknown) => (hostCalls++, callee);
	assert.equal(interpret(`function f() { return 1; } class C { m() { return 2; } } f() + new C().m()`, { hostGuard: { beforeCall } }), 3);
	assert.equal(hostCalls, 0);
});

test("onAsyncFiber is told about every async function and async-generator invocation", async () => {
	const fibers: Promise<unknown>[] = [];
	const vm = createVM(`async function f() { await 0; return 1; } async function* g() { yield 1; } f(); f(); g().next(); "done"`, { onAsyncFiber: (p) => void fibers.push(p) });
	vm.run();
	assert.equal(fibers.length, 3);
	assert.deepEqual(await Promise.all(fibers), [1, 1, { value: 1, done: false }]);
});

test("resolveModule is the import seam: a host decides what `import` and `import()` resolve to", async () => {
	const requested: string[] = [];
	const resolveModule = (spec: string) => (requested.push(spec), { default: { read: () => `read:${spec}` }, named: 7 });
	assert.equal(interpret(`import fs from "node:fs"; import { named } from "x"; fs.read() + named`, { resolveModule }), "read:node:fs7");
	assert.deepEqual(requested, ["node:fs", "x"]);
	assert.equal(await interpretAsync(`import("y").then((m) => m.named)`, { resolveModule }), 7);
});
