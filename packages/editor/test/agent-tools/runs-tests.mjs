/**
 * Test files run as runs_tests runs them (`tests.run`): a package loaded, a test at a commit opened beside the work by
 * its path, a write the policy doesn't decide asked about and approved, a run stopped from outside, and its stages as
 * spans.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/runs-tests.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("runs-tests");
const { ask, runTests } = session;

test("a package the program imports loads in the run", async () => {
	await session.request("files.write", { "path": "debugger-package.test.mjs", "content": `import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";

test("react", () => { assert.equal(typeof React.createElement, "function"); });
` }, 30_000);

	const answer = await runTests(["debugger-package.test.mjs"]);

	assert.deepEqual(answer.counts, { "files": 1, "pass": 1, "fail": 0, "skip": 0 }, JSON.stringify(answer).slice(0, 1500));
});

test("a test file at a commit opened beside the work runs from there: its own modules as that commit has them", async () => {
	await session.request("files.write", { "path": "refs-run/value.mjs", "content": "export const value = \"as committed\";\n" }, 30_000);
	await session.request("files.write", { "path": "refs-run/value.test.mjs", "content": `import assert from "node:assert/strict";
import { test } from "node:test";
import { value } from "./value.mjs";

test("imports its neighbour", () => {
	assert.equal(value, "as committed");
});
` }, 30_000);
	await session.request("git.commit", { "message": "refs: a test to run at its commit", "files": [{ "path": "refs-run/value.mjs" }, { "path": "refs-run/value.test.mjs" }] }, 60_000);
	// (changed since: the commit's is what the run loads)
	await session.request("files.write", { "path": "refs-run/value.mjs", "content": "export const value = \"changed since\";\n" }, 30_000);

	const commit = (await session.request("git.log", { "limit": 1 }, 30_000)).commits[0].oid.slice(0, 12);
	const { path } = await session.request("git.openRef", { "ref": commit }, 60_000);
	const answer = await runTests([`${path}/refs-run/value.test.mjs`]);

	assert.deepEqual(answer.counts, { "files": 1, "pass": 1, "fail": 0, "skip": 0 }, JSON.stringify(answer).slice(0, 2000));
});

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

test("a run of test files stopped from outside (runs_stop) stops whole, as Ctrl+C stops node --test: the files after it not run", async () => {
	await session.request("files.write", { "path": "stop-hangs.test.mjs", "content": "import { test } from \"node:test\";\n\ntest(\"hangs\", () => new Promise(() => { setInterval(() => {}, 1000); }));\n" }, 30_000);
	await session.request("files.write", { "path": "stop-after.test.mjs", "content": "import { test } from \"node:test\";\n\ntest(\"after\", () => {});\n" }, 30_000);

	const started = await session.request("tests.run", { "files": ["stop-hangs.test.mjs", "stop-after.test.mjs"], "answerMs": 3000 }, 60_000);

	assert.ok(started.running !== undefined, JSON.stringify(started).slice(0, 800));

	// (its file's run, as runs_list has it, stopped as runs_stop stops it)
	let hanging;

	for (let tries = 0; hanging === undefined && tries < 60; tries++) {
		hanging = (await ask("runs.list", {})).find((run) => run.title === "node --test stop-hangs.test.mjs" && run.state === "running");

		if (hanging === undefined) {
			await new Promise((resolve) => { setTimeout(resolve, 500); });
		}
	}

	assert.ok(hanging !== undefined, "its file's run is listed");
	await ask("runs.stop", { "id": hanging.id });

	let answer = started;

	for (let asked = 0; answer.running !== undefined && asked < 10; asked++) {
		answer = await session.request("tests.run", { "run": started.run }, 120_000);
	}

	assert.match(answer.stopped ?? "", /stopped/u, JSON.stringify(answer).slice(0, 1500));
	assert.deepEqual(answer.files.map((each) => each.file), ["stop-hangs.test.mjs"], "the file after it isn't run");
});

test("a run's stages are spans: under its run's, the runtime loaded, its entry parsed, its first step — and on its end, what it asked of the editor", async () => {
	const ended = (stage) => (line) => line.startsWith("[debug-worker]") && line.includes("← editor.extensions.tsval.worker." + stage);
	// (a run of its own: the page prints every record it collects, a span's end as `← name (ms)` and its attributes — but
	// keeps only its latest 5,000 lines, which a cold page's CDN fetches on CI can push an earlier test's run out of)
	await session.request("files.write", { "path": "debugger-spans.test.mjs", "content": "import { test } from \"node:test\";\n\ntest(\"runs\", () => {});\n" }, 30_000);
	await runTests(["debugger-spans.test.mjs"]);

	const run = await session.eventually("a run's span ended", async () => session.printed().findLast(ended("session.run")), 30_000).catch((error) => {
		const worker = session.printed().filter((line) => line.startsWith("[debug-worker]"));

		throw new Error(`${error.message}: of the ${String(session.printed().length)} lines the page printed, kept, ${String(worker.length)} are the debug worker's, the last: ${worker.slice(-8).join("\n")}`, { "cause": error });
	});
	const printed = session.printed().filter((line) => line.startsWith("[debug-worker]"));

	for (const stage of ["session.load", "session.parse", "session.step"]) {
		assert.ok(printed.some(ended(stage)), `${stage} ended: ${printed.slice(-12).join("\n")}`);
	}

	// (each file the run read through the editor, counted and timed, with its exit)
	assert.match(run, /"exitCode":\d/u, run);
	assert.match(run, /"readFile":\d+,"readFileMs":\d+/u, run);
});
