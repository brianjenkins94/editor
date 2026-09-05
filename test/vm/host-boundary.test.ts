/**
 * The host-boundary seams a sandboxing host builds on (a capability canary lives in its own repo):
 * `hostGuard.sanitize` sees every host→guest value crossing, `hostGuard.beforeCall` vets every host
 * callable the guest invokes, `onAsyncFiber` is told about every async invocation, and
 * `resolveModule` is the import seam. Tested directly, at the interpreter's level.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { interpret, interpretAsync, createVM } from "../../src/index.ts";
import { createTypedVM, type TypedHostCallSite } from "../../src/typed.ts";

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
	const { vm } = createVM(`async function f() { await 0; return 1; } async function* g() { yield 1; } f(); f(); g().next(); "done"`, { onAsyncFiber: (p) => void fibers.push(p) });
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

test("beforeCall receives the callsite: node, evaluated arguments, construct flag", () => {
	const sites: string[] = [];
	const beforeCall = (callee: (...a: unknown[]) => unknown, _this: unknown, _isNew: boolean, site: import("../../src/index.ts").HostCallSite) => {
		sites.push(`${ts.SyntaxKind[site.node.kind]}:${JSON.stringify(site.args)}:${site.isConstruct}:${"checker" in site ? "typed" : "untyped"}`);
		return callee;
	};
	const globals = { f: (...a: unknown[]) => a.length, K: class {} };
	interpret("const xs = [2, 3]; f(1, ...xs); new K(\"k\"); f`t${1}`", { globals, hostGuard: { beforeCall } });
	assert.deepEqual(sites, ['CallExpression:[1,2,3]:false:untyped', 'NewExpression:["k"]:true:untyped', 'TaggedTemplateExpression:[["t",""],1]:false:untyped']);
});

test("vm.callSite is already set while beforeCall runs", () => {
	let seen: unknown;
	const { vm } = createVM(`host()`, { globals: { host: () => 1 }, hostGuard: { beforeCall: (callee) => ((seen = vm.callSite), callee) } });
	vm.run();
	assert.ok(seen !== undefined && ts.isCallExpression(seen as ts.Node));
});

test("typed layer: a guard can answer with a stand-in shaped like the call's declared result type", () => {
	// A host `load` that must not run: the guard synthesizes a value from the static return type.
	const load = () => {
		throw new Error("the real load must not run");
	};
	const beforeCall = (callee: (...a: unknown[]) => unknown, _this: unknown, _isNew: boolean, site: TypedHostCallSite) => {
		const type = site.returnType();
		const checker = site.checker;
		if (type === undefined) return callee;
		const shaped: Record<string, unknown> = {};
		for (const prop of type.getProperties()) {
			const t = checker.typeToString(checker.getTypeOfSymbolAtLocation(prop, site.node));
			shaped[prop.name] = t === "number" ? 0 : t === "string" ? "" : t === "boolean" ? false : null;
		}
		return () => shaped;
	};
	const code = `declare function load(id: number): { id: number; name: string; active: boolean }; const u = load(7); [u.id, u.name, u.active, typeof u]`;
	const { vm } = createTypedVM(code, { globals: { load }, hostGuard: { beforeCall } });
	vm.run();
	assert.deepEqual(vm.completion, [0, "", false, "object"]);
});

test("typed layer: signature() and argumentType() expose the declared parameter and argument types", () => {
	const seen: string[] = [];
	const beforeCall = (callee: (...a: unknown[]) => unknown, _this: unknown, _isNew: boolean, site: TypedHostCallSite) => {
		const checker = site.checker;
		const sig = site.signature();
		seen.push(`params=${sig?.getParameters().map((p) => p.name).join(",")} ret=${checker.typeToString(sig!.getReturnType())} arg0=${checker.typeToString(site.argumentType(0) as ts.Type)}`);
		return callee;
	};
	const { vm } = createTypedVM(`declare function send(url: URL, body: string): Promise<number>; send(new URL("https://x"), "hi")`, { globals: { send: () => 1, URL }, hostGuard: { beforeCall } });
	vm.run();
	// (the `new URL(...)` construction is a host call the guard sees too — its own site, its own signature)
	assert.deepEqual(seen, ['params=url,base ret=URL arg0="https://x"', "params=url,body ret=Promise<number> arg0=URL"]);
});

test("a host Proxy that answers every property (an auto-stub) is a host callable, not guest code", () => {
	// A stub answers `__tsval` like any other key; only an OWN brand marks a guest function. Without
	// the own-property check the VM takes the stub for guest code — it never reaches the guard, and
	// it tries to run the stub's (nonexistent) AST.
	const stub = (): unknown => new Proxy(function stub() {}, { get: (_t, key) => (typeof key === "symbol" || key === "then" ? undefined : stub()), apply: () => stub(), construct: () => stub() as object });
	const seen: string[] = [];
	const { vm } = createVM(`db().query("x").rows[0]`, { globals: { db: stub() }, hostGuard: { beforeCall: (callee) => (seen.push(typeof callee), callee) } });
	assert.strictEqual(typeof vm.run(), "function");
	assert.deepStrictEqual(seen, ["function", "function"]); // `db()` and `.query("x")` both crossed the seam
});
