/**
 * almostnode's Node built-ins (builtins.ts: unenv's, almostnode's own where it must differ): for each, how many of Node's
 * names it really has — present, and not a stub that only says it isn't implemented — held to a floor, so a change
 * that loses some (a shim deleted for unenv's that had more, an override dropped) fails here, and one that gains can
 * raise it. Node's names are this Node's own.
 */
import * as assert from "node:assert/strict";
import { createRequire, register } from "node:module";
import { test } from "node:test";

register("./extensionless.mjs", import.meta.url);

const { Runtime } = await import("../runtime.ts");
const { VirtualFS } = await import("../virtual-fs.ts");

/** The least of Node's names each built-in really has (2026-10-14: unenv's as the base). */
const FLOORS: Record<string, number> = {
	"assert": 19,
	"assert/strict": 19,
	"async_hooks": 7,
	// (9, not 11: almostnode's transcode only copied and its resolveObjectURL was always undefined — unenv's say they
	// aren't implemented instead of answering wrongly)
	"buffer": 9,
	"child_process": 6,
	"cluster": 12,
	"console": 25,
	"constants": 228,
	"crypto": 23,
	"dgram": 3,
	"diagnostics_channel": 5,
	"dns": 37,
	"dns/promises": 33,
	"domain": 5,
	"events": 13,
	"fs": 57,
	"fs/promises": 13,
	"http": 15,
	"http2": 10,
	"https": 6,
	"inspector": 6,
	"module": 14,
	"net": 10,
	"os": 22,
	"path": 16,
	"path/posix": 16,
	"perf_hooks": 10,
	"process": 80,
	"punycode": 6,
	"querystring": 7,
	"readline": 8,
	"readline/promises": 3,
	"repl": 2,
	"stream": 9,
	"stream/promises": 2,
	"string_decoder": 1,
	"sys": 17,
	"timers": 7,
	"timers/promises": 4,
	"tls": 14,
	"trace_events": 2,
	"tty": 3,
	"url": 12,
	"util": 17,
	"util/types": 16,
	"v8": 20,
	"vm": 10,
	"worker_threads": 18,
	"zlib": 34
};

/** A function that only says it isn't there: unenv's notImplemented, or a shim's own. */
const STUB = /notImplemented|createNotImplementedError|is not implemented|not (?:yet )?(?:implemented|supported)|ENOSYS/u;

test("each built-in has at least as much of Node's API as it did", () => {
	const runtime = new Runtime(new VirtualFS(), { "cwd": "/" });
	const node = createRequire(import.meta.url);
	const short: string[] = [];

	for (const [name, floor] of Object.entries(FLOORS)) {
		const names = Object.keys(node("node:" + name) as object).filter((key) => key !== "default" && key !== "__esModule");
		const ours = runtime.execute(`module.exports = require(${JSON.stringify(name)});`, "/probe.js").exports as Record<string, unknown>;
		const real = names.filter((key) => key in Object(ours) && !(typeof ours[key] === "function" && STUB.test(Function.prototype.toString.call(ours[key]))));

		if (real.length < floor) {
			short.push(`${name}: ${real.length} of Node's names, below its floor of ${floor}`);
		}
	}

	assert.deepEqual(short, []);
});
