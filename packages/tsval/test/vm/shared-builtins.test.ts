/**
 * The built-ins a program shares with its host, held apart (src/shared-builtins.ts): the program's changes to them are
 * in place while its code runs and the host's own built-ins are back between, as a debugger's worker steps it.
 *
 *   node --test test/vm/shared-builtins.test.ts
 */
import assert from "node:assert";
import { test } from "node:test";
import { createVM } from "../../src/interpret.ts";
import { SharedBuiltins } from "../../src/shared-builtins.ts";

function logged(): { "lines": unknown[]; "globals": Record<string, unknown> } {
	const lines: unknown[] = [];

	return {
		"lines": lines,
		"globals": {
			"log": (value: unknown) => { lines.push(value); }
		}
	};
}

test("the program's changes hold while it runs, step after step; the host's built-ins are its own between", () => {
	const { lines, globals } = logged();
	const builtins = new SharedBuiltins();
	const { vm } = createVM(`
		Object.prototype.then = function (resolve) { resolve("mine"); };
		Array.prototype.extra = 5;
		delete Math.hypot;
		log([typeof ({}).then, [].extra, typeof Math.hypot]);
		log([typeof ({}).then, [].extra, typeof Math.hypot]);
	`, { "builtins": builtins, "globals": globals });
	const host = (): unknown[] => [typeof ({} as { "then"?: unknown }).then, ([] as unknown as { "extra"?: unknown }).extra, typeof Math.hypot];

	vm.stepStatement();
	vm.stepStatement();
	vm.stepStatement();
	assert.deepStrictEqual(host(), ["undefined", undefined, "function"], "between steps, the host's own");
	vm.stepStatement();
	assert.deepStrictEqual(host(), ["undefined", undefined, "function"]);
	vm.run();
	assert.deepStrictEqual(lines, [
		["function", 5, "undefined"],
		["function", 5, "undefined"]
	], "the program's, each time it runs");
	assert.deepStrictEqual(host(), ["undefined", undefined, "function"]);
	assert.deepStrictEqual(builtins.changed().sort(), ["Array.prototype.extra", "Math.hypot", "Object.prototype.then"]);
});

test("a host's call into one of the program's functions runs it on the program's built-ins", () => {
	let read: (() => unknown) | undefined;
	const { vm } = createVM(`
		Array.prototype.extra = 7;
		give(() => [].extra);
	`, {
		"builtins": new SharedBuiltins(),
		"globals": {
			"give": (fn: () => unknown) => { read = fn; }
		}
	});

	vm.run();
	assert.strictEqual(([] as unknown as { "extra"?: unknown }).extra, undefined);
	assert.strictEqual(read?.(), 7, "called from the host, between steps");
	assert.strictEqual(([] as unknown as { "extra"?: unknown }).extra, undefined);
});

test("what can't be undone stays, named", () => {
	const builtins = new SharedBuiltins();
	const { vm } = createVM("Object.defineProperty(Math, \"heldForGood\", { \"value\": 1, \"configurable\": false });", { "builtins": builtins });

	vm.run();
	assert.strictEqual((Math as unknown as { "heldForGood"?: unknown }).heldForGood, 1);
	assert.deepStrictEqual(builtins.lasting, ["Math.heldForGood"]);
});
