/**
 * An AsyncLocalStorage's store carried as Node carries it (shims/async_hooks.ts; runtime.ts asyncContextEdits): through
 * a module's awaits, its async functions' catch and for-await bodies, promise callbacks and timers — in a CommonJS module,
 * an ES module and a `.cjs` one, and with a directive at the top of an async function's body.
 *
 *   node --test test/async-context.test.ts
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";

import "./extensionless.mjs";

const { Runtime } = await import("../runtime.ts");
const { VirtualFS } = await import("../virtual-fs.ts");

/** The cases, as a module's body: `als` and `tick` are the module's, `cases` its export. */
const CASES = `
const tick = () => new Promise((resolve) => { setTimeout(resolve, 1); });
async function seen(label) { await tick(); return label + ":" + als.getStore(); }
async function strict(label) {
	"use strict";
	try { await Promise.reject(new Error(label)); } catch { await null; return als.getStore(); } finally { void 0; }
}
const cases = () => Promise.all([
	als.run("a", async () => { await null; const one = als.getStore(); await tick(); return [one, als.getStore()]; }),
	als.run("b", async () => { await tick(); return als.getStore(); }),
	als.run("c", async () => { try { await Promise.reject(new Error("x")); } catch { return als.getStore(); } }),
	als.run("d", () => new Promise((resolve) => { setTimeout(() => { resolve(als.getStore()); }, 1); })),
	als.run("e", () => Promise.resolve().then(() => als.getStore())),
	als.run("f", async () => {
		const got = [];
		for await (const each of (async function* () { yield 1; await tick(); yield 2; })()) got.push(each + als.getStore());
		got.push(als.getStore());
		return got;
	}),
	als.run("g", async () => als.run("h", async () => { await tick(); return als.getStore(); }).then((inner) => [inner, als.getStore()])),
	als.run("i", () => seen("i")),
	als.run("j", () => strict("j")),
	(async () => { await tick(); return als.getStore(); })()
]);
`;
const EXPECTED = [["a", "a"], "b", "c", "d", "e", ["1f", "2f", "f"], ["h", "g"], "i:i", "j", undefined];

test("an AsyncLocalStorage's store goes through a CommonJS module's awaits, as Node's does", async () => {
	const runtime = new Runtime(new VirtualFS());
	const cases = runtime.execute(`const { AsyncLocalStorage } = require("async_hooks");\nconst als = new AsyncLocalStorage();\n${CASES}\nmodule.exports = cases;`, "/cases.js").exports as () => Promise<unknown>;

	assert.deepEqual(await cases(), EXPECTED);
});

test("…and an ES module's, and a .cjs module's (which has no ES syntax to transform)", async () => {
	const vfs = new VirtualFS();

	vfs.writeFileSync("/esm.mjs", `import { AsyncLocalStorage } from "node:async_hooks";\nconst als = new AsyncLocalStorage();\n${CASES}\nexport { cases };`);
	vfs.writeFileSync("/plain.cjs", `const { AsyncLocalStorage } = require("node:async_hooks");\nconst als = new AsyncLocalStorage();\n${CASES}\nmodule.exports = cases;`);

	const runtime = new Runtime(vfs);
	const { esm, plain } = runtime.execute(`module.exports = { "esm": require("/esm.mjs").cases, "plain": require("/plain.cjs") };`, "/load.js").exports as Record<string, () => Promise<unknown>>;

	assert.deepEqual(await esm!(), EXPECTED);
	assert.deepEqual(await plain!(), EXPECTED);
});

test("a store kept by one module is seen by another's code it calls, across both's awaits", async () => {
	const vfs = new VirtualFS();

	vfs.writeFileSync("/store.js", `const { AsyncLocalStorage } = require("async_hooks");\nmodule.exports = new AsyncLocalStorage();`);
	vfs.writeFileSync("/reader.js", `const als = require("/store.js");\nmodule.exports = async () => { await new Promise((resolve) => setTimeout(resolve, 1)); return als.getStore(); };`);

	const runtime = new Runtime(vfs);
	const run = runtime.execute(`const als = require("/store.js");\nconst read = require("/reader.js");\nmodule.exports = () => Promise.all([als.run(1, async () => { await null; return read(); }), als.run(2, read)]);`, "/main.js").exports as () => Promise<unknown>;

	assert.deepEqual(await run(), [1, 2]);
});
