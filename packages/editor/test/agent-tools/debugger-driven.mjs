/**
 * The debugger as an agent drives it (`debug.*`, `margin.state`): what a person has of it is in-editor/debugger.spec.mjs's.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/debugger-driven.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("debugger-driven");
const { ask } = session;

test("the debugger, as an agent drives it: Run to a breakpoint, a step, a call's question answered, the Margin read, stopped", async () => {
	await ask("files.write", { "path": "driven.mjs", "content": "import { writeFileSync } from \"node:fs\";\n\nconst rate = 2;\nconst total = rate * 10;\nwriteFileSync(\"/workspace/driven.txt\", String(total));\nconsole.log(\"total \" + total);\n" });

	const stopped = await session.request("debug.start", { "program": "driven.mjs", "breakpoints": [3] }, 120_000);

	assert.deepEqual([stopped.state, stopped.reason, stopped.line, stopped.code], ["stopped", "breakpoint", 3, "const rate = 2;"]);
	assert.deepEqual((await ask("debug.sessions")).map(({ session: id, state }) => [id, state]), [[stopped.session, "stopped"]]);

	const stepped = await ask(`debug.session.${stopped.session}.step`, { "action": "next" });

	assert.deepEqual([stepped.state, stepped.line], ["stopped", 4]);
	assert.ok(stepped.locals.some(({ name, value }) => name === "rate" && value === "2"), JSON.stringify(stepped.locals));

	// On to the write: the policy hasn't decided it, so it stops and asks, in the Margin too.
	const asked = await ask(`debug.session.${stopped.session}.step`, { "action": "continue" });

	assert.deepEqual([asked.state, asked.reason, asked.line], ["stopped", "capability", 5]);

	const margin = await ask("margin.state", { "file": "driven.mjs" });

	assert.deepEqual([margin.question?.line, margin.question?.capability], [5, "fs:write"]);
	assert.ok(margin.rows.some(({ line, label, value }) => line === 4 && label.startsWith("total") && value === "20"), JSON.stringify(margin.rows));

	// Skipped, as the Margin's Skip does: the run goes on, writing nothing.
	const ended = await ask(`debug.session.${stopped.session}.decide`, { "choice": "skip" });

	assert.equal(ended.state, "terminated");
	assert.deepEqual(ended.output, ["total 20"]);
	await assert.rejects(ask("files.read", { "path": "driven.txt" }), /doesn't exist/u);

	// Another, stopped from here, its breakpoints cleared.
	await ask("debug.breakpoints", { "program": "driven.mjs", "lines": [] });

	const again = await session.request("debug.start", { "program": "driven.mjs" }, 60_000);

	assert.equal(again.reason, "capability");
	assert.equal((await ask(`debug.session.${again.session}.stop`)).state, "terminated");
	assert.deepEqual(await ask("debug.sessions"), []);
});
