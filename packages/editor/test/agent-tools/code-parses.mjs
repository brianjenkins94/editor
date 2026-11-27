/**
 * Which files BABLR parses, as `code_parses` asks (`bablr.check`, workbench/bablr.ts), and the same asked again.
 * What a person has of it is in-editor/bablr.spec.mjs's.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/code-parses.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("code-parses");
const { ask } = session;

test("which files BABLR parses, as code_parses asks: each it can't and why, its lines, and the same asked again", async () => {
	await ask("files.write", { "path": "parses/fine.ts", "content": "export const fine = 1;\n" });
	await ask("files.write", { "path": "parses/broken.ts", "content": "export const = ;\n" });

	// (the first waits out BABLR's worker loading)
	const checked = await session.request("bablr.check", { "path": "parses" }, 300_000);

	assert.deepEqual([checked.files, checked.parsed, checked.lines, checked.parsedLines], [2, 1, 4, 2]);
	assert.deepEqual(checked.unparsable.map(({ file }) => file), ["parses/broken.ts"]);
	const again = await session.request("bablr.check", { "path": "parses" }, 120_000);

	assert.deepEqual([again.files, again.parsed, again.lines, again.parsedLines], [2, 1, 4, 2], "asked again, the same answer");
	await assert.rejects(ask("bablr.check", {}), /takes \{ path/u);
});
