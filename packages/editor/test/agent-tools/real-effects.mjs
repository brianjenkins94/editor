/**
 * A run's real effects, decided per call (worker/gate.ts, bridge/runtime-fs.ts): a write the policy doesn't decide stops
 * the run and asks; approved, it's made, and the run goes on.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/real-effects.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("real-effects");
const { runTests } = session;

test("a write the policy doesn't decide stops the run and asks; approved, it's made, the run going on from there", async () => {
	await session.request("files.write", { "path": "debugger-first.test.mjs", "content": "import { test } from \"node:test\";\n\ntest(\"first\", () => {});\n" }, 30_000);
	await session.request("files.write", { "path": "debugger-writes.test.mjs", "content": `import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

test("writes", () => {
	writeFileSync("/workspace/debugger-wrote.txt", "written");
	assert.equal(readFileSync("/workspace/debugger-wrote.txt", "utf8"), "written");
});
` }, 30_000);

	const files = ["debugger-first.test.mjs", "debugger-writes.test.mjs"];
	const asked = await runTests(files);

	assert.match(asked.ask?.key ?? "", /^runs_tests:fs:write/u, JSON.stringify(asked).slice(0, 1500));

	// (made again with the approval, as a tool's call is: the same run, on from the file that asked, the first kept)
	const approved = await runTests(files, [asked.ask.key]);

	assert.equal(approved.run, asked.run, JSON.stringify(approved).slice(0, 1500));
	assert.deepEqual(approved.files.map((each) => each.file), files);
	assert.deepEqual(approved.counts, { "files": 2, "pass": 2, "fail": 0, "skip": 0 }, JSON.stringify(approved).slice(0, 1500));
});
