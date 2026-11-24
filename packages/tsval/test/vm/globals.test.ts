/**
 * The default global object is ECMAScript's standard namespace and nothing of the host's; the
 * host's real globals are reachable only when a host asks for them (`realGlobals: true`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createVM, interpret, standardGlobals } from "../../src/index.ts";

test("the standard built-ins are there by default", () => {
	assert.equal(interpret(`Math.max(1, 2) + JSON.parse("[3]")[0] + [...new Set([4])][0] + Number.parseInt("5")`), 14);
	assert.equal(interpret(`typeof Promise + typeof Symbol.iterator + typeof Reflect.ownKeys + typeof Intl`), "functionsymbolfunctionobject");
	assert.equal(interpret(`class E extends Error {} new E("m") instanceof Error`), true);
});

test("the host's globals are not: process, require, fetch, timers, console are ReferenceErrors", () => {
	for (const name of ["process", "require", "fetch", "setTimeout", "queueMicrotask", "console", "Buffer", "eval"]) {
		assert.throws(() => interpret(name), ReferenceError, name);
		assert.equal(interpret(`typeof ${name}`), "undefined", name);
	}
});

test("globalThis is the guest's own global object: writing to it never touches the host's", () => {
	const marker = `tsval_probe_${Date.now()}`;

	assert.equal(interpret(`globalThis.${marker} = 1; globalThis.${marker} + (globalThis === globalThis.globalThis ? 1 : 0)`), 2);
	assert.ok(!(marker in globalThis), "the host's globalThis was not written");
});

test("`globals` layer on top of the standard table; `realGlobals: true` restores the host fallthrough", () => {
	assert.equal(interpret(`host() + Math.PI`, { "globals": { "host": () => 1 } }), 1 + Math.PI);
	assert.equal(interpret(`typeof process`, { "realGlobals": true }), "object");
	assert.equal(interpret(`typeof process`), "undefined");
});

test("standardGlobals() is a fresh table each time (a host may add to it without affecting the next VM)", () => {
	const first = standardGlobals();
	const second = standardGlobals();

	assert.notStrictEqual(first, second);
	assert.strictEqual(first.Object, Object);
	assert.strictEqual(first.globalThis, first);
	assert.ok(!("eval" in first) && !("process" in first));
});

test("`sharedGlobals`: what's set there (a run's packages' own globals) is the program's too, read and assigned — only that", () => {
	const shared: Record<PropertyKey, unknown> = { "polyfilled": 1 };

	assert.equal(interpret(`polyfilled + 1`, { "sharedGlobals": shared }), 2);
	interpret(`polyfilled = 5`, { "sharedGlobals": shared });
	assert.equal(shared.polyfilled, 5, "an assignment is the shared global's");
	assert.equal(interpret(`typeof process`, { "sharedGlobals": shared }), "undefined", "nothing of the host's through it");
	assert.equal(interpret(`Math.max(1, 2)`, { "sharedGlobals": { "Math": { "max": () => 0 } } }), 2, "the program's own global wins");
});

test("a function another machine made is a host function to this one: it runs on its own, out of this one's sight", () => {
	// (the editor's tests run tsval under the editor's debugger: the program's machine was handed the debugger's
	// functions, and stepped them itself, on its own observers)
	const theirs = interpret(`(() => "theirs")`);
	const seen: string[] = [];
	const { vm } = createVM(`theirs() + " " + (() => "mine")()`, { "globals": { "theirs": theirs }, "observe": (_node, site) => { seen.push(site); } });

	assert.equal(vm.run(), "theirs mine");
	assert.deepEqual(seen.filter((site) => site === "return"), ["return"], "only its own function's return");
});

test("the language's own functions: each standard built-in, the functions on it and up its prototypes, getters and setters too — not a host's, a program's, or Atomics.waitAsync", async () => {
	const { languageFunctions } = await import("../../src/globals.ts");
	const own = languageFunctions(globalThis as unknown as Record<string, unknown>);
	const getter = (holder: object, key: PropertyKey): unknown => Reflect.getOwnPropertyDescriptor(holder, key)?.get;

	for (const each of [Promise, Promise.resolve, Promise.prototype.then, Array.prototype.pop, Array.fromAsync, Reflect.apply, Object.defineProperty, Object.prototype.hasOwnProperty, Function.prototype.call, getter(Map.prototype, "size"), getter(Symbol.prototype, "description"), getter(Intl.DateTimeFormat.prototype, "format")]) {
		assert.ok(own.has(each as object), String((each as { "name"?: string }).name));
	}

	for (const each of [setTimeout, queueMicrotask, structuredClone, (globalThis as { "Atomics": { "waitAsync"?: object } }).Atomics.waitAsync, function program() {}, () => undefined]) {
		if (each !== undefined) {
			assert.equal(own.has(each), false, String((each as { "name"?: string }).name));
		}
	}
});
