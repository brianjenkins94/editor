/**
 * Tests run in the debugger, end to end: a test file written into a real editor's workspace (files.write) and run as
 * an agent's runs_tests runs it (tests.run) — node:test on tsval in the debug worker, its results as data. What the
 * unit tests can't reach: the debug worker loading, a run's launch, its tests told, a failure's sides, a timer on the
 * run's event loop, a read through the runtime's files.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/debugger-runs.mjs
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startSession } from "./architecture-harness.mjs";

let session;

before(async () => {
	session = await startSession();
});

after(async () => {
	await session?.close("debugger-runs");
});

const FILE = `import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("adds", () => { assert.equal(1 + 1, 2); });
test("fails", () => { assert.equal(1 + 1, 3); });
test("waits", async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
test("reads its own file", () => { assert.match(readFileSync("/workspace/debugger-runs.test.mjs", "utf8"), /adds/u); });
`;

test("a test file's tests run in the debugger: each one's outcome, a failure's sides, a timer, a read", async () => {
	await session.request("files.write", { "path": "debugger-runs.test.mjs", "content": FILE }, 30_000);

	let answer = await session.request("tests.run", { "files": ["debugger-runs.test.mjs"] }, 120_000);

	// (a call answers within a minute, done or not: then the run, asked again by its id)
	for (let asked = 1; answer.counts === undefined && typeof answer.run === "string" && asked < 10; asked++) {
		answer = await session.request("tests.run", { "run": answer.run }, 120_000);
	}

	const tests = Object.fromEntries((answer.files ?? []).flatMap((file) => file.tests).map((each) => [each.id.split(" › ").at(-1), each]));

	assert.deepEqual(answer.counts, { "files": 1, "pass": 3, "fail": 1, "skip": 0 }, JSON.stringify(answer).slice(0, 2000));
	assert.equal(tests.adds.outcome, "pass");
	assert.equal(tests.fails.outcome, "fail");
	assert.deepEqual(tests.fails.assertion, { "actual": "2", "expected": "3", "operator": "strictEqual" });
	assert.equal(tests.waits.outcome, "pass", "a timer on the run's event loop");
	assert.equal(tests["reads its own file"].outcome, "pass", "a read through the runtime's files");
});
