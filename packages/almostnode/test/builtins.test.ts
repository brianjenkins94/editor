/**
 * almostnode's Node built-ins (builtins.ts: unenv's, almostnode's own where it must differ): for each, how many of Node's
 * names it really has — present, and not a stub that only says it isn't implemented — held to a floor, so a change
 * that loses some (a shim deleted for unenv's that had more, an override dropped) fails here, and one that gains can
 * raise it. Node's names are this Node's own.
 */
import * as assert from "node:assert/strict";
import { createRequire } from "node:module";
import { test } from "node:test";

import "./extensionless.mjs";

const { Runtime } = await import("../runtime.ts");
const { VirtualFS } = await import("../virtual-fs.ts");

/** The least of Node's names each built-in really has (2026-10-14: unenv's as the base; streams, string_decoder and
 *  events' EventEmitter Node's own code from npm). */
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
	// (1, 14: since 2026-10-24 what unenv's mocks pretended — a socket that sent nothing, a serialized value an empty
	// buffer — says it isn't implemented)
	"dgram": 1,
	"diagnostics_channel": 5,
	"dns": 37,
	"dns/promises": 33,
	"domain": 5,
	"events": 14,
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
	"stream": 21,
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
	// (40: almostnode's own since 2026-10-24, where unenv's said most weren't implemented)
	"util/types": 40,
	"v8": 14,
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

test("assert is Node's: a failure says what differed, and deep equality looks inside", () => {
	const runtime = new Runtime(new VirtualFS());
	const failure = runtime.execute(`try { require("assert").strictEqual(1, 2); } catch (error) { module.exports = { "name": error.name, "message": error.message, "actual": error.actual }; }`, "/probe.js").exports as { "name": string; "message": string; "actual": number };

	assert.equal(failure.name, "AssertionError");
	assert.match(failure.message, /strictly equal/u);
	assert.equal(failure.actual, 1);
	assert.throws(() => runtime.execute(`require("assert/strict").deepEqual(new Map([[1, 2]]), new Map([[1, 3]]));`, "/maps.js"), { "name": "AssertionError" }, "two Maps that differ aren't equal");
	runtime.execute(`require("assert/strict").deepEqual(new Map([[1, { "a": [2] }]]), new Map([[1, { "a": [2] }]]));`, "/same.js");
});

test("util is Node's: inspect, format and deep equality as Node's say them", () => {
	const runtime = new Runtime(new VirtualFS());
	const said = runtime.execute(`const util = require("util"); module.exports = [util.inspect(new Map([[1, { "a": [1, 2, { "b": 3 }] }]])), util.inspect("str"), util.inspect([1, , 3]), util.inspect(123n), util.inspect(require("buffer").Buffer.from("hi")), util.format("%s %d %i %j %%", "a", 1.5, 2.7, { "x": 1 }), util.format(1, 2, "x"), util.isDeepStrictEqual(new Map([[1, 2]]), new Map([[1, 3]]))];`, "/util.js").exports;

	assert.deepEqual(said, ["Map(1) { 1 => { a: [ 1, 2, [Object] ] } }", "'str'", "[ 1, <1 empty item>, 3 ]", "123n", "<Buffer 68 69>", "a 1.5 2 {\"x\":1} %", "1 2 x", false]);
});

test("util.types: Node's answers — a boxed primitive is an object, typed arrays by their kind", () => {
	const runtime = new Runtime(new VirtualFS());
	const said = runtime.execute(`const types = require("util/types"); module.exports = [types.isBooleanObject(true), types.isBooleanObject(new Boolean(true)), types.isUint8Array(new Uint8Array()), types.isUint8Array(new Uint16Array()), types.isAsyncFunction(async () => 1), types.isGeneratorFunction(function* () {}), types.isNativeError(new TypeError()), types.isBoxedPrimitive(Object(1n)), types.isArrayBufferView(new DataView(new ArrayBuffer(1))), require("util").types.isDate(new Date())];`, "/types.js").exports;

	assert.deepEqual(said, [false, true, true, false, true, true, true, true, true, true]);
});

test("path is Node's posix path: a backslash is a name's, and resolve starts from the program's directory", () => {
	const runtime = new Runtime(new VirtualFS(), { "cwd": "/workspace" });
	const said = runtime.execute(`const path = require("path"); module.exports = [path.join("a\\\\b", "c"), path.normalize("a\\\\b/../c"), path.posix.isAbsolute("C:\\\\x"), path.basename("/a/b/", ".b"), path.format({ "dir": "/x", "name": "n", "ext": "e" }), path.resolve("x"), require("path/posix") === path.posix];`, "/workspace/path.js").exports;

	assert.deepEqual(said, ["a\\b/c", "c", false, "b/", "/x/n.e", "/workspace/x", true]);
});

test("timers are the realm's when called, and timers/promises waits — and an abort rejects it", async () => {
	const runtime = new Runtime(new VirtualFS());
	const { timers, promises } = runtime.execute(`module.exports = { "timers": require("timers"), "promises": require("timers/promises") };`, "/timers.js").exports as { "timers": { "setTimeout": (fn: () => void, ms: number) => unknown }; "promises": { "setTimeout": (ms: number, value: string, options?: { "signal": AbortSignal }) => Promise<string>; "setInterval": (ms: number, value: string) => AsyncGenerator<string>; "scheduler": { "wait": (ms: number) => Promise<void> } } };
	const original = globalThis.setTimeout;
	let used = 0;

	// (a realm's timers made Node's after this module loaded — the runtime's are: unenv's had bound the first ones)
	globalThis.setTimeout = ((fn: () => void, ms: number) => {
		used += 1;

		return original(fn, ms);
	}) as typeof setTimeout;

	try {
		timers.setTimeout(() => undefined, 0);
		assert.equal(used, 1, "the realm's setTimeout as it is when called");
	} finally {
		globalThis.setTimeout = original;
	}

	const started = performance.now();

	assert.equal(await promises.setTimeout(40, "late"), "late");
	assert.ok(performance.now() - started >= 35, "it waited");
	await promises.scheduler.wait(1);

	const aborting = new AbortController();
	const waiting = promises.setTimeout(10_000, "never", { "signal": aborting.signal });

	aborting.abort();
	await assert.rejects(waiting, { "name": "AbortError", "code": "ABORT_ERR" });

	const ticks: string[] = [];

	for await (const tick of promises.setInterval(5, "tick")) {
		ticks.push(tick);

		if (ticks.length === 3) {
			break;
		}
	}

	assert.deepEqual(ticks, ["tick", "tick", "tick"]);
});

test("diagnostics_channel: a channel nobody made has no subscribers — false, as Node says", () => {
	const runtime = new Runtime(new VirtualFS());

	assert.equal(runtime.execute(`module.exports = require("diagnostics_channel").hasSubscribers("nobody's");`, "/dc.js").exports, false);
});

test("readline reads the input's lines: line events, a question's answer, the last line at its end", async () => {
	const runtime = new Runtime(new VirtualFS());
	const read = runtime.execute(`
const { Readable } = require("stream");
const readline = require("readline");
const seen = [];
const rl = readline.createInterface({ "input": Readable.from(["first\\nsec", "ond\\r\\n", "third"]) });

rl.on("line", (line) => seen.push(line));
module.exports = new Promise((resolve) => rl.on("close", () => resolve(seen)));`, "/readline.js").exports as Promise<string[]>;

	assert.deepEqual(await read, ["first", "second", "third"]);

	const answered = runtime.execute(`
const { PassThrough } = require("stream");
const input = new PassThrough();
const written = [];
const rl = require("readline/promises").createInterface({ "input": input, "output": { "write": (text) => written.push(text) } });
const answer = rl.question("name? ");

input.write("ada\\n");
module.exports = answer.then(async (name) => {
	const rest = [];
	// (the loop listening before the lines come, as a program's does)
	const reading = (async () => {
		for await (const line of rl) {
			rest.push(line);
		}
	})();

	input.end("x\\ny\\n");
	await reading;

	return [name, written, rest];
});`, "/question.js").exports as Promise<unknown>;

	assert.deepEqual(await answered, ["ada", ["name? "], ["x", "y"]]);
});

test("what almostnode can't do says so as it's used: a UDP socket, v8's serialization — and a Worker can still be made", () => {
	const runtime = new Runtime(new VirtualFS());

	for (const call of ["require(\"dgram\").createSocket(\"udp4\")", "require(\"v8\").serialize({ \"a\": 1 })"]) {
		assert.throws(() => runtime.execute(call, "/stub.js"), /is not implemented/u, call);
	}

	// (tools make one as they load, and never use it here: eslint-plugin-jsonc, through synckit)
	runtime.execute("new (require(\"worker_threads\").Worker)(\"./w.js\");", "/worker.js");
});
