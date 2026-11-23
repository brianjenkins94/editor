/**
 * A run's console (extensions/tsval/worker/guest-console.ts): Node's whole console, not only its log — a program's
 * console.time, count, assert and group say what Node's say, where they'd have thrown (an almostnode Runtime made in a
 * run binds every one of them, 2026-11-23).
 *
 *   node --import tsx --test test/guest-console.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { consoleOf } = await import("../extensions/tsval/worker/guest-console.ts");

test("time, count, assert and group say what Node's do; every method Node's console has is there", () => {
	const said = [];
	let clock = 0;
	const console = consoleOf((stream, method, args, indent) => { said.push([stream, method, indent + args.join(" ")]); }, () => clock);

	console.time("load");
	clock = 1.5;
	console.timeLog("load", "halfway");
	console.timeEnd("load");
	console.timeEnd("load");
	console.count();
	console.count();
	console.countReset();
	console.count();
	console.assert(true, "fine");
	console.assert(false, "broken %s", "here");
	console.group("outer");
	console.log("inside");
	console.groupEnd();
	console.log("out");

	assert.deepEqual(said, [
		["stdout", "log", "load: 1.500ms halfway"],
		["stdout", "log", "load: 1.500ms"],
		["stderr", "warn", "Warning: No such label 'load' for console.timeEnd()"],
		["stdout", "log", "default: 1"],
		["stdout", "log", "default: 2"],
		["stdout", "log", "default: 1"],
		["stderr", "assert", "Assertion failed: broken %s here"],
		["stdout", "log", "outer"],
		["stdout", "log", "  inside"],
		["stdout", "log", "out"]
	]);

	for (const method of ["log", "info", "debug", "dir", "dirxml", "table", "warn", "error", "trace", "assert", "count", "countReset", "time", "timeLog", "timeEnd", "group", "groupCollapsed", "groupEnd", "clear"]) {
		assert.equal(typeof console[method], "function", method);
	}
});
