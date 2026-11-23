/**
 * A run's own global (run-global.ts; RuntimeOptions.global): what its modules set on `globalThis` — a Proxy over a host
 * object, as just-bash's sandbox puts there, or a polyfill — is theirs, seen by their free names and their `globalThis`,
 * and not the host's. And code from a string (`runEval`) is the run's too.
 *
 *   node --test test/run-global.test.ts
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";


const { Runtime } = await import("../runtime.ts");
const { VirtualFS } = await import("../virtual-fs.ts");
const { createRunGlobal, runEval } = await import("../run-global.ts");

test("what a run's module sets on globalThis is the run's: its free names see it, the host's global doesn't", () => {
	const run = createRunGlobal();
	const vfs = new VirtualFS();

	vfs.writeFileSync("/setter.js", `globalThis.performance = new Proxy(performance, {}); globalThis.polyfilled = 1; module.exports = globalThis;`);
	vfs.writeFileSync("/reader.js", `module.exports = { "polyfilled": polyfilled, "proxied": performance === globalThis.performance, "itself": globalThis === global, "typeofMissing": typeof notAGlobal };`);

	const runtime = new Runtime(vfs, { "global": run });
	const { setter, reader } = runtime.execute(`module.exports = { "setter": require("/setter.js"), "reader": require("/reader.js") };`, "/main.js").exports as { "setter": unknown; "reader": Record<string, unknown> };

	assert.equal(setter, run.global, "a module's globalThis is the run's");
	assert.deepEqual(reader, { "polyfilled": 1, "proxied": true, "itself": true, "typeofMissing": "undefined" });
	assert.equal("polyfilled" in globalThis, false, "the host's global has none of it");
	assert.equal(typeof performance.now(), "number", "and its performance is its own");
	assert.equal(run.own.process, runtime.process, "the wrapper's `globalThis.process` is the run's too");
});

test("a host function read off the run's global keeps the host's global as its receiver; constructors stay themselves", async () => {
	const run = createRunGlobal();
	const runtime = new Runtime(new VirtualFS(), { "global": run });
	const got = runtime.execute(`const later = new Promise((resolve) => { globalThis.setTimeout(resolve, 1, "fired"); });
module.exports = { "later": later, "same": globalThis.setTimeout === globalThis.setTimeout, "map": new globalThis.Map([[1, 2]]).get(1), "date": globalThis.Date === Date, "instance": new Date(0) instanceof globalThis.Date };`, "/timers.js").exports as Record<string, unknown>;

	assert.equal(await got.later, "fired");
	assert.deepEqual({ ...got, "later": undefined }, { "later": undefined, "same": true, "map": 2, "date": true, "instance": true });
});

test("without a run's global, a module's globalThis is the host's, as before", () => {
	const runtime = new Runtime(new VirtualFS());

	assert.equal(runtime.execute(`module.exports = globalThis;`, "/host.js").exports, globalThis);
});

test("code from a string is the run's: its globals read and set, `this` the run's global, its value returned — not the host's", () => {
	const run = createRunGlobal();
	const evaluate = runEval(run);

	run.global.seen = 41;
	assert.equal(evaluate("seen + 1"), 42);
	evaluate("globalThis.made = 'here'; this.also = true");
	assert.equal(run.own["made"], "here");
	assert.equal(run.own["also"], true);
	assert.equal((globalThis as Record<string, unknown>)["made"], undefined, "not the host's");
	assert.equal(evaluate("(function() { return typeof made; })()"), "string");
	assert.deepEqual(evaluate({ "not": "a string" }), { "not": "a string" });
	assert.equal(evaluate.name, "eval");
	assert.throws(() => evaluate("throw new TypeError('from the string')"), TypeError);
});

test("code from a string sees the program's globals: its global object first, then the run's — none of the host's — and `globalThis` is the program's", () => {
	const run = createRunGlobal();
	const table: Record<PropertyKey, unknown> = { "Math": Math, "answer": 42 };

	table["globalThis"] = table;
	run.own["shared"] = "from a package";

	const evaluate = runEval(run, () => table);

	assert.equal(evaluate("globalThis"), table, "the program's own global object");
	assert.equal(evaluate("this"), table);
	assert.equal(evaluate("answer + 1"), 43);
	assert.equal(evaluate("shared"), "from a package");
	assert.equal(evaluate("typeof setTimeout"), "undefined", "the host's isn't the program's");
	evaluate("made = 1; shared = 'changed'");
	assert.equal(table["made"], 1, "a name made is the program's global's, as sloppy code makes one");
	assert.equal(run.own["shared"], "changed", "a run's own is set where it is");
	assert.equal(evaluate("eval('answer')"), 42, "an eval inside it sees the same");
});
