/**
 * node:vm's contexts as Node's are, as far as a realm of the host's own allows (shims/vm.ts): the context object is the
 * code's `globalThis`, `this` and free names, with the language's built-ins on its global; the host's global keeps none
 * of it.
 *
 *   node --test test/vm.test.ts
 */
import * as assert from "node:assert/strict";
import * as nodeVm from "node:vm";
import { test } from "node:test";


const ours = await import("../shims/vm.ts");

/** The same code in Node's vm and ours: what it returns, and what its context holds after. */
function both(code: string, context: () => Record<string, unknown>): unknown[] {
	return [nodeVm, ours].map((vm) => {
		const each = context();
		const result = vm.runInNewContext(code, each) as unknown;

		return [result, Object.fromEntries(Object.entries(each).filter(([, value]) => typeof value !== "function"))];
	});
}

test("a context is the code's globalThis and this, and what it assigns lands there, not on the host's global", () => {
	const [node, mine] = both("globalThis.a = 1; this.b = 2; c = 3; [typeof globalThis.given, given + 1, typeof Math.max, globalThis === this]", () => ({ "given": 41 }));

	// (as JSON: Node's array is its context's realm's)
	assert.equal(JSON.stringify(mine), JSON.stringify(node));
	assert.deepEqual(mine, [["number", 42, "function", true], { "given": 41, "a": 1, "b": 2, "c": 3 }]);
	assert.equal("a" in globalThis || "c" in globalThis, false);
});

test("a preview's instrumented prelude finds its runtime on the context's globalThis", () => {
	const seen: string[] = [];
	const runtime = { "module": () => ({ "s": (index: number) => { seen.push("statement " + index); } }) };

	ours.runInNewContext("const __ev = globalThis.__evidence?.module() ?? { s() {} };\n__ev.s(0);", { "__evidence": runtime });
	assert.deepEqual(seen, ["statement 0"]);
});

test("runInThisContext runs at the global scope, as Node's", () => {
	assert.equal(ours.runInThisContext("typeof Script"), "undefined", "none of the shim's own names");
	assert.equal(ours.runInThisContext("1 + 1"), 2);
});

test("a context's global has the language's built-ins, as a new context of Node's has — code copying its intrinsics off globalThis finds them", () => {
	const code = "const copied = {}; for (const name of ['Array', 'Object', 'Reflect', 'Math', 'JSON']) { copied[name] = typeof globalThis[name]; } [copied, 'Array' in globalThis, typeof globalThis.fetch, typeof globalThis.given, globalThis.globalThis === globalThis, Object.keys(globalThis).includes('given')]";
	const [node, mine] = both(code, () => ({ "given": 1 }));

	assert.equal(JSON.stringify(mine), JSON.stringify(node));
	assert.deepEqual(mine, [[{ "Array": "function", "Object": "function", "Reflect": "object", "Math": "object", "JSON": "object" }, true, "undefined", "number", true, true], { "given": 1 }]);
});
