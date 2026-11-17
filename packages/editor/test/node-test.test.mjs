/**
 * The editor's node:test (extensions/tsval/node-test.js), run here by Node as the debugger runs it: a test's `timeout`
 * fails it as node's does once it hasn't settled in time, and one that settles within it passes; and its `mock` holds
 * where node's does, the same tests passing under both.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

/** What `body` (tests declared with `test` from the editor's node:test, or with `node`, Node's own) prints when Node runs it. */
function ran(body, { node = false } = {}) {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "node-test-"));

	try {
		// (CommonJS, as the debugger loads it: its own folder's package is a module one)
		fs.copyFileSync(new URL("../extensions/tsval/node-test.js", import.meta.url), path.join(folder, "node-test.cjs"));
		fs.writeFileSync(path.join(folder, "tests.cjs"), `const test = require(${JSON.stringify(node ? "node:test" : "./node-test.cjs")});\n${body}\n`);

		return execFileSync(process.execPath, [
			path.join(folder, "tests.cjs")
		], { "encoding": "utf8", "env": { ...process.env, "NODE_TEST_CONTEXT": undefined } });
	} finally {
		fs.rmSync(folder, { "recursive": true, "force": true });
	}
}

test("a test's timeout fails it as node's does when it hasn't settled in time; one that settles in time passes", () => {
	const printed = ran([
		"test(\"never settles\", { timeout: 30 }, () => new Promise(() => {}));",
		"test(\"settles in time\", { timeout: 1000 }, () => new Promise((resolve) => { setTimeout(resolve, 10); }));",
		"test(\"no timeout\", () => {});"
	].join("\n"));

	assert.match(printed, /✖ never settles\n\s+(?:\S.*)?test timed out after 30ms/u, printed);
	assert.match(printed, /✔ settles in time/u, printed);
	assert.match(printed, /✔ no timeout/u, printed);
	assert.match(printed, /ℹ pass 2\nℹ fail 1/u, printed);
});

/** Tests of `mock` that hold under node's own, so under the editor's they say it does as node's does. */
const MOCKED = String.raw`
const assert = require("node:assert/strict");
const { mock } = test;

test("timers: due ones run on a tick, in the order they're due; one set as another runs is due from the tick's end; cleared ones don't", () => {
	mock.timers.enable({ "apis": ["setTimeout", "setInterval"] });

	try {
		const ran = [];

		setTimeout(() => { ran.push("b"); }, 20);
		setTimeout(() => { ran.push("a"); setTimeout(() => { ran.push("a2"); }, 5); }, 10);
		clearTimeout(setTimeout(() => { ran.push("never"); }, 15));
		mock.timers.tick(9);
		assert.deepEqual(ran, []);
		mock.timers.tick(11);
		assert.deepEqual(ran, ["a", "b"]);
		mock.timers.tick(5);
		assert.deepEqual(ran, ["a", "b", "a2"]);

		// (one of no delay set as another runs: due now, so in the same tick)
		const now = [];

		setTimeout(() => { now.push("z"); setTimeout(() => { now.push("z2"); }, 0); }, 0);
		mock.timers.tick(0);
		assert.deepEqual(now, ["z", "z2"]);

		const every = [];
		const interval = setInterval((what) => { every.push(what); }, 10, "x");

		mock.timers.tick(35);
		clearInterval(interval);
		mock.timers.tick(100);
		assert.deepEqual(every, ["x", "x", "x"]);
	} finally {
		mock.timers.reset();
	}
});

test("timers: Date and setImmediate on the mocked clock, and runAll; reset gives the real ones back", () => {
	const realSetTimeout = setTimeout;

	mock.timers.enable({ "apis": ["setTimeout", "setImmediate", "Date"], "now": 1000 });

	try {
		assert.equal(Date.now(), 1000);
		assert.equal(new Date().getTime(), 1000);
		assert.equal(new Date(5).getTime(), 5);

		const ran = [];

		setImmediate(() => { ran.push("immediate"); });
		setTimeout(() => { ran.push("later"); }, 500);
		mock.timers.runAll();
		assert.deepEqual(ran, ["immediate", "later"]);
		assert.equal(Date.now(), 1500);
	} finally {
		mock.timers.reset();
	}

	assert.equal(setTimeout, realSetTimeout);
	assert.notEqual(Date.now(), 1500);
});

test("fn: its calls kept, with their arguments, results and this; an implementation, once and for good", () => {
	const add = mock.fn((one, other) => one + other);

	assert.equal(add(1, 2), 3);
	add.mock.mockImplementationOnce(() => "once");
	assert.equal(add(1, 2), "once");
	assert.equal(add(2, 2), 4);
	assert.equal(add.mock.callCount(), 3);
	assert.deepEqual(add.mock.calls.map((call) => [call.arguments, call.result]), [[[1, 2], 3], [[1, 2], "once"], [[2, 2], 4]]);
	add.mock.resetCalls();
	assert.equal(add.mock.callCount(), 0);
});

test("method: an object's method mocked, its calls kept, and restored", () => {
	const object = { "greet": (who) => "hello, " + who };
	const greet = mock.method(object, "greet", (who) => "hi, " + who);

	assert.equal(object.greet("ada"), "hi, ada");
	assert.equal(greet.mock.calls[0].arguments[0], "ada");
	greet.mock.restore();
	assert.equal(object.greet("ada"), "hello, ada");
});
`;

test("mock: fn, method and timers do as node's do — the same tests pass under both", () => {
	for (const node of [true, false]) {
		const printed = ran(MOCKED, { "node": node });

		assert.match(printed, /ℹ pass 4\nℹ fail 0/u, `${node ? "node's" : "the editor's"}: ${printed}`);
	}
});
