/**
 * Trace File Calls as an agent opens it (`fs.trace`): each call at a boundary, for a while, as the trace's records.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/trace-file-calls.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("trace-file-calls");
const { ask } = session;

test("Trace File Calls: each call at a boundary, for a while — its operation, caller, path and time — as the trace's records", async () => {
	const opened = await ask("fs.trace", { "boundary": "zenfs", "path": "traced/", "seconds": 5 });

	assert.equal(opened.tracing, "zenfs, paths with traced/");
	await assert.rejects(ask("fs.trace", { "boundary": "zenfs" }), /a trace is open/u, "one at a time");
	await ask("files.write", { "path": "traced/a.txt", "content": "traced\n" });

	// (each call a record in the window's span, as the root prints every record: `[source] text`)
	const calls = await session.eventually("the write's store calls", async () => {
		const found = session.printed().filter((line) => line.startsWith("[workbench]") && /\bzenfs (?:write|create|stat|read)\b/u.test(line));

		return found.some((line) => line.includes("zenfs write") && line.includes("traced/a.txt")) ? found : undefined;
	}, 30_000);

	assert.ok(calls.every((line) => line.includes("traced/")), calls.slice(0, 3).join("\n"));
	await assert.rejects(ask("fs.trace", { "boundary": 1 }), /takes \{ boundary/u);
});
