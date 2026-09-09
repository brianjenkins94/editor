/**
 * The default global object is ECMAScript's standard namespace and nothing of the host's; the
 * host's real globals are reachable only when a host asks for them (`realGlobals: true`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { interpret, standardGlobals } from "../../src/index.ts";

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
	const a = standardGlobals();
	const b = standardGlobals();

	assert.notStrictEqual(a, b);
	assert.strictEqual(a.Object, Object);
	assert.strictEqual(a.globalThis, a);
	assert.ok(!("eval" in a) && !("process" in a));
});
