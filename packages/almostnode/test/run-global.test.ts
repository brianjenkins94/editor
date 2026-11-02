/**
 * A run's own global (run-global.ts; RuntimeOptions.global): what its modules set on `globalThis` — a Proxy over a host
 * object, as just-bash's sandbox puts there, or a polyfill — is theirs, seen by their free names and their `globalThis`,
 * and not the host's.
 *
 *   node --test test/run-global.test.ts
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";

import "./extensionless.mjs";

const { Runtime } = await import("../runtime.ts");
const { VirtualFS } = await import("../virtual-fs.ts");
const { createRunGlobal } = await import("../run-global.ts");

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
