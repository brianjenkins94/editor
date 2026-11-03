/**
 * The debugger, end to end, in a real editor: test files written into its workspace (files.write) and run as an
 * agent's runs_tests runs them (tests.run) — node:test on tsval in the debug worker, its results as data — and a
 * program debugged as a person does. What the unit tests can't reach: the debug worker loading, a run's launch, its
 * tests told, a failure's sides, a timer on the run's event loop, a read through the runtime's files, a capability stop
 * asked and answered, a package loaded, a step and a step back at a breakpoint, and stdin typed at a terminal's run.
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

/** Run test files as runs_tests does, to their end (a call answers within a minute: then the run, asked again). */
async function runTests(files, approved) {
	let answer = await session.request("tests.run", { "files": files, ...approved === undefined ? {} : { "approved": approved } }, 120_000);

	for (let asked = 1; answer.counts === undefined && answer.ask === undefined && typeof answer.run === "string" && asked < 10; asked++) {
		answer = await session.request("tests.run", { "run": answer.run }, 120_000);
	}

	return answer;
}

test("a test file's tests run in the debugger: each one's outcome, a failure's sides, a timer, a read", async () => {
	await session.request("files.write", { "path": "debugger-runs.test.mjs", "content": FILE }, 30_000);

	const answer = await runTests(["debugger-runs.test.mjs"]);

	const tests = Object.fromEntries((answer.files ?? []).flatMap((file) => file.tests).map((each) => [each.id.split(" › ").at(-1), each]));

	assert.deepEqual(answer.counts, { "files": 1, "pass": 3, "fail": 1, "skip": 0 }, JSON.stringify(answer).slice(0, 2000));
	assert.equal(tests.adds.outcome, "pass");
	assert.equal(tests.fails.outcome, "fail");
	assert.deepEqual(tests.fails.assertion, { "actual": "2", "expected": "3", "operator": "strictEqual" });
	assert.equal(tests.waits.outcome, "pass", "a timer on the run's event loop");
	assert.equal(tests["reads its own file"].outcome, "pass", "a read through the runtime's files");
});

test("a write the policy doesn't decide stops the run and asks; approved, it's made", async () => {
	await session.request("files.write", { "path": "debugger-writes.test.mjs", "content": `import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";

test("writes", () => {
	writeFileSync("/workspace/debugger-wrote.txt", "written");
	assert.equal(readFileSync("/workspace/debugger-wrote.txt", "utf8"), "written");
});
` }, 30_000);

	const asked = await runTests(["debugger-writes.test.mjs"]);

	assert.match(asked.ask?.key ?? "", /^runs_tests:fs:write/u, JSON.stringify(asked).slice(0, 1500));

	const approved = await runTests(["debugger-writes.test.mjs"], [asked.ask.key]);

	assert.deepEqual(approved.counts, { "files": 1, "pass": 1, "fail": 0, "skip": 0 }, JSON.stringify(approved).slice(0, 1500));
});

test("a package the program imports loads in the run", async () => {
	await session.request("files.write", { "path": "debugger-package.test.mjs", "content": `import assert from "node:assert/strict";
import { test } from "node:test";
import React from "react";

test("react", () => { assert.equal(typeof React.createElement, "function"); });
` }, 30_000);

	const answer = await runTests(["debugger-package.test.mjs"]);

	assert.deepEqual(answer.counts, { "files": 1, "pass": 1, "fail": 0, "skip": 0 }, JSON.stringify(answer).slice(0, 1500));
});

test("a breakpoint stops the run; a step goes on a line, a step back returns to it", async () => {
	await session.request("files.write", { "path": "debugger-steps.mjs", "content": "let x = 1;\nx = 2;\nx = 3;\nconsole.log(x);\n" }, 30_000);

	const lines = await session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/debugger-steps.mjs");
		const until = async (what, probe) => {
			for (let tried = 0; tried < 300; tried++) {
				const found = await probe().catch(() => undefined);

				if (found !== undefined) {
					return found;
				}

				await new Promise((resolve) => { setTimeout(resolve, 100); });
			}

			throw new Error("gave up waiting for " + what);
		};
		const line = async (debug) => (await debug.customRequest("stackTrace", { "threadId": 1, "levels": 1 })).stackFrames[0]?.line;
		const stoppedAt = async (debug, wanted) => until(`a stop at line ${wanted}`, async () => ((await line(debug)) === wanted ? wanted : undefined));

		api.debug.addBreakpoints([new api.SourceBreakpoint(new api.Location(uri, new api.Position(1, 0)))]);
		await api.debug.startDebugging(undefined, { "type": "tsval", "request": "launch", "name": "debugger-steps", "program": uri.path });

		const debug = await until("the session", async () => api.debug.activeDebugSession ?? undefined);
		const seen = [await stoppedAt(debug, 2)];

		await debug.customRequest("next", { "threadId": 1 });
		seen.push(await stoppedAt(debug, 3));
		await debug.customRequest("stepBack", { "threadId": 1 });
		seen.push(await stoppedAt(debug, 2));
		api.debug.removeBreakpoints(api.debug.breakpoints);
		await debug.customRequest("continue", { "threadId": 1 });

		return seen;
	});

	assert.deepEqual(lines, [2, 3, 2]);
});

test("stdin: what's typed at a terminal's run reaches the program", async () => {
	await session.request("files.write", { "path": "debugger-stdin.mjs", "content": "process.stdin.on(\"data\", (data) => { console.log(\"got \" + String(data).trim()); process.exit(0); });\n" }, 30_000);
	await session.terminal("node debugger-stdin.mjs", { "fresh": true });
	await new Promise((resolve) => { setTimeout(resolve, 3000); });
	await session.terminal("hello");

	const output = await session.eventually("the program's answer", async () => {
		const terminals = await session.request("terminal.state", { "lines": 30 }, 10_000);
		const said = terminals.map((each) => each.output).join("\n");

		return said.includes("got hello") ? said : undefined;
	}, 60_000);

	assert.match(output, /got hello/u);
});
