/**
 * The debugger, end to end, in a real editor: test files written into its workspace (files.write) and run as an
 * agent's runs_tests runs them (tests.run) — node:test on tsval in the debug worker, its results as data — and a
 * program debugged as a person does. What the unit tests can't reach: the debug worker loading, a run's launch, its
 * tests told, a failure's sides, a timer on the run's event loop, a read through the runtime's files, a capability stop
 * asked and answered (a test run's approval; a stop allowed, skipped and denied, each asked once), a package loaded,
 * a step and a step back at a breakpoint, and stdin typed at a terminal's run.
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

	for (let asked = 1; answer.running !== undefined && answer.ask === undefined && asked < 10; asked++) {
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

test("a capability stop answered at the call: allowed once, skipped, denied — each as the program and the disk see it", async () => {
	await session.request("files.write", { "path": "debugger-stops.mjs", "content": `import { writeFileSync } from "node:fs";
const said = [];
try { writeFileSync("/workspace/stop-allowed.txt", "a"); said.push("allowed: wrote"); } catch { said.push("allowed: refused"); }
try { writeFileSync("/workspace/stop-skipped.txt", "s"); said.push("skipped: wrote"); } catch { said.push("skipped: refused"); }
try { writeFileSync("/workspace/stop-denied.txt", "d"); said.push("denied: wrote"); } catch { said.push("denied: refused"); }
console.log(said.join(", "));
` }, 30_000);

	const output = await session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
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
		const printed = [];
		const tracker = api.debug.registerDebugAdapterTrackerFactory("tsval", {
			"createDebugAdapterTracker": () => ({
				"onDidSendMessage": (message) => {
					if (message.type === "event" && message.event === "output") {
						printed.push(message.body.output);
					}
				}
			})
		});

		await api.debug.startDebugging(undefined, { "type": "tsval", "request": "launch", "name": "debugger-stops", "program": "/workspace/debugger-stops.mjs" });

		const debug = await until("the session", async () => api.debug.activeDebugSession ?? undefined);

		// (each answered once it's asked: before, the command says the run isn't stopped at a capability call)
		for (const choice of ["allow-once", "skip", "deny"]) {
			await until(`the stop to ${choice}`, async () => api.commands.executeCommand("editor.capability.decide", debug.id, choice).then(() => true));
		}

		try {
			return await until("the program's line", async () => printed.join("").split("\n").find((each) => each.startsWith("allowed:")));
		} catch (error) {
			throw new Error(`${error.message}; it printed ${JSON.stringify(printed)}`, { "cause": error });
		} finally {
			tracker.dispose();
			await api.debug.stopDebugging(debug);
		}
	});

	assert.equal(output, "allowed: wrote, skipped: wrote, denied: refused");
	assert.equal((await session.request("files.read", { "path": "stop-allowed.txt" }, 10_000)).content, "1\ta");
	await assert.rejects(session.request("files.read", { "path": "stop-skipped.txt" }, 10_000), /doesn't exist/u, "a skipped write did nothing");
	await assert.rejects(session.request("files.read", { "path": "stop-denied.txt" }, 10_000), /doesn't exist/u);
});

test("a stopped call asks in the margin, on its line, until it's answered: there's nothing to dismiss", async () => {
	const view = session.workbench();
	const program = "/workspace/margin-asks.mjs";

	await session.request("files.write", { "path": "margin-asks.mjs", "content": `import { writeFileSync } from "node:fs";

writeFileSync("/workspace/margin-wrote.txt", "written");
` }, 30_000);
	await view.evaluate(async (file) => {
		const { api } = globalThis.__editor;

		await api.window.showTextDocument(api.Uri.file(file));
		void api.debug.startDebugging(undefined, { "type": "tsval", "request": "launch", "name": "margin-asks", "program": file });
	}, program);

	const question = view.locator(".pane-item.tone-question, .pane-item.tone-warning");

	await question.waitFor({ "timeout": 60_000 });
	assert.match(await question.innerText(), /writeFileSync.*margin-wrote\.txt.*fs:write/su);
	await session.eventually("still asking, with nothing yet written", async () => (await question.count() === 1 ? true : undefined), 5000);
	await assert.rejects(session.request("files.read", { "path": "margin-wrote.txt" }, 10_000), /doesn't exist/u);

	await question.locator("wa-button", { "hasText": "Allow" }).first().click();
	await question.waitFor({ "state": "detached", "timeout": 30_000 });
	await session.eventually("the call made", async () => session.request("files.read", { "path": "margin-wrote.txt" }, 10_000).then(({ content }) => (content.includes("written") ? true : undefined), () => undefined), 30_000);
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
	await session.request("files.write", { "path": "debugger-stdin.mjs", "content": "process.stdin.on(\"data\", (data) => { console.log(\"got \" + String(data).trim()); process.exit(0); });\nconsole.log(\"listening\");\n" }, 30_000);
	await session.terminal("node debugger-stdin.mjs", { "fresh": true });

	const said = async (text) => {
		const terminals = await session.request("terminal.state", { "lines": 30 }, 10_000);
		const output = terminals.map((each) => each.output).join("\n");

		return output.includes(text) ? output : undefined;
	};

	// (typed once the program reads: before its debug session is up, a line goes to no one — a wait of a fixed time
	// was sometimes too short)
	await session.eventually("the program listening", async () => said("listening"), 60_000).catch(async (error) => {
		const terminals = await session.request("terminal.state", { "lines": 30 }, 10_000).catch(() => []);

		throw new Error(`${error.message}; the terminals said ${JSON.stringify(terminals)}`, { "cause": error });
	});
	await session.terminal("hello");

	const output = await session.eventually("the program's answer", async () => said("got hello"), 60_000);

	assert.match(output, /got hello/u);
});

test("the bridge: the extension host's one hub, linked to the workbench's, and every debug run's worker linked to it; other extensions only for their records", () => {
	const { nodes, channels } = session.seen();
	const linked = (one, other) => channels.some((channel) => channel.linked && ((channel.a === one && channel.b === other) || (channel.a === other && channel.b === one)));
	// (the hub's links: the view's other channels are what's reported on it — extensions' command calls, their workers' traffic)
	const onHub = [...new Set(channels.filter((channel) => channel.linked).flatMap((channel) => [channel.a, channel.b]))];

	assert.ok(nodes.some((node) => node.id === "bridge" && node.state === "alive"), "the bridge reports on the page: its uplink works");
	assert.ok(linked("workbench", "bridge"), JSON.stringify(onHub));
	assert.ok(linked("bridge", "debug-worker"), "a debug run's worker links to the bridge (the workspace runtime's link)");
	// (the other extensions are on the architecture view as their commands; on the hub, at most for their records —
	// observeExtension's `ext:<name>`, linked to the workbench, never the bridge — and not as hubs of their own)
	assert.deepEqual(onHub.filter((id) => ["tsval", "history", "source-control"].includes(id) || id.startsWith("exthost")), []);
	assert.ok(channels.filter((channel) => channel.linked && (channel.a.startsWith("ext:") || channel.b.startsWith("ext:"))).every((channel) => [channel.a, channel.b].includes("workbench")), "an extension's records link to the workbench");
});
