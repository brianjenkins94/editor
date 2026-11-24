/**
 * Checkpoints as an agent tries a change (`workspace.checkpoint`, `workspace.restore`): all of it put back.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/checkpoints-undone.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("checkpoints-undone");
const { ask } = session;

test("checkpoints, as an agent tries a change: noted, changed, a file made, and all of it put back", async () => {
	await ask("files.write", { "path": "tried/one.mjs", "content": "export const one = 1;\n" });

	const { id } = await ask("workspace.checkpoint", { "label": "before" });

	await ask("files.edit", { "path": "tried/one.mjs", "old": "1", "new": "2" });
	await ask("files.write", { "path": "tried/two.mjs", "content": "export const two = 2;\n" });

	const back = await session.request("workspace.restore", { "id": id }, 120_000);

	assert.deepEqual([back.restored, back.removed], [["tried/one.mjs"], ["tried/two.mjs"]]);
	assert.equal((await ask("files.read", { "path": "tried/one.mjs" })).content, "1\texport const one = 1;\n2\t");
	await assert.rejects(ask("files.read", { "path": "tried/two.mjs" }), /doesn't exist/u);
	await assert.rejects(ask("workspace.restore", { "id": "nothing" }), /no checkpoint nothing/u);
});
