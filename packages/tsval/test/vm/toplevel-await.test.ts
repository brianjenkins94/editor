/**
 * Top-level await: the program's main body is itself a suspendable fiber, driven by `runAsync`.
 * (Not differentially testable — Node's script `eval` has no top-level await — so unit-tested.)
 */
import assert from "node:assert";
import { test } from "node:test";
import { TsvalInternalError } from "../../src/errors.ts";
import { createVM, interpretAsync } from "../../src/interpret.ts";

test("runAsync drives a top-level await to completion", async () => {
	assert.strictEqual(await interpretAsync(`const v = await Promise.resolve(41); v + 1`), 42);
	assert.deepStrictEqual(await interpretAsync(`const a = await 1; const b = await Promise.resolve(2); [a, b]`), [1, 2]);
});

test("a rejected top-level await is a catchable throw at the await", async () => {
	assert.strictEqual(await interpretAsync(`let r; try { await Promise.reject(new Error("no")); } catch (e) { r = e.message; } r`), "no");
});

test("the synchronous run() refuses a top-level await loudly instead of resuming with undefined", () => {
	const { vm } = createVM(`const v = await Promise.resolve(1); v`);

	assert.throws(() => vm.run(), (error: unknown) => error instanceof TsvalInternalError && (error as Error).message.includes("runAsync"));
});

test("for await at top level, over an async generator", async () => {
	const code = `async function* g() { yield 1; yield await Promise.resolve(2); } const out = []; for await (const v of g()) out.push(v); out`;

	assert.deepStrictEqual(await interpretAsync(code), [1, 2]);
});
