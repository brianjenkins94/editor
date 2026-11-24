/**
 * A package a run imports, loaded in the run from what package.json pins (worker/install.ts): nothing installed.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/packages-in-run.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("packages-in-run");
const { runTests } = session;

test("a package the program imports loads in the run", async () => {
	await session.request("files.write", { "path": "debugger-package.test.mjs", "content": `import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";

test("react", () => { assert.equal(typeof React.createElement, "function"); });
` }, 30_000);

	const answer = await runTests(["debugger-package.test.mjs"]);

	assert.deepEqual(answer.counts, { "files": 1, "pass": 1, "fail": 0, "skip": 0 }, JSON.stringify(answer).slice(0, 1500));
});
