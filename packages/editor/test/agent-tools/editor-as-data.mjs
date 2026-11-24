/**
 * The editor as data, as an agent reads it (editor-state.ts): the file in front, its tabs, the Problems view and the
 * notifications showing.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/editor-as-data.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("editor-as-data");
const { ask } = session;

test("the editor as data: the file in front and its tabs, the Problems view, the notifications showing", async () => {
	await ask("files.write", { "path": "shown.ts", "content": "const count: number = \"not a number\";\nexport { count };\n" });
	await session.open("shown.ts");

	const state = await session.eventually("shown.ts in front", async () => {
		const answer = await ask("editor.state");

		return answer.active?.file === "shown.ts" ? answer : undefined;
	}, 30_000);

	assert.deepEqual([state.active.language, state.active.lines, state.active.cursor], ["typescript", 3, { "line": 1, "column": 1 }]);
	assert.ok(state.tabs.some((tab) => tab.file === "shown.ts" && tab.active));

	// TypeScript's error on it, once the language service has the file.
	const problem = await session.eventually("TypeScript's error", async () => (await ask("problems.list", { "file": "shown.ts" })).problems.find((each) => each.source === "ts"), 120_000);

	assert.deepEqual([problem.file, problem.line, problem.severity], ["shown.ts", 1, "error"]);

	await session.workbench().evaluate(() => {
		void globalThis.__editor.api.window.showInformationMessage("a notification for the agent");
	});
	await session.eventually("the notification", async () => ((await ask("notifications.list")).some((each) => each.message === "a notification for the agent") ? true : undefined), 30_000);

	await assert.rejects(ask("editor.trace", {}), /takes \{ component/u);
});
