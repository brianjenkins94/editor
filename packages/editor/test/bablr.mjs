/**
 * Which files BABLR parses, in a real editor (workbench/bablr.ts, its worker workers/bablr-worker.ts): a folder checked
 * says how much BABLR's grammar takes, a file it can't take is a warning in Problems until it parses again, and a file
 * asked about again is answered from what's kept, not parsed again.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/bablr.mjs
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startSession } from "./architecture-harness.mjs";

let session;

before(async () => {
	session = await startSession();
});

after(async () => {
	await session?.close("bablr");
});

/** BABLR's warnings on `file`, as the Problems view has them. */
const warnings = async (file) => (await session.request("problems.list", { "file": file }, 10_000)).problems.filter((problem) => problem.source === "BABLR");

test("a folder checked: what BABLR parses, a file it can't a warning in Problems until it does, and asked again from what's kept", async () => {
	await session.request("files.write", { "path": "parses/fine.ts", "content": "export const fine = 1;\n" }, 30_000);
	await session.request("files.write", { "path": "parses/broken.ts", "content": "export const = ;\n" }, 30_000);

	// (the first waits out BABLR's worker loading)
	const checked = await session.request("bablr.check", { "path": "parses" }, 300_000);

	assert.equal(checked.files, 2);
	assert.equal(checked.parsed, 1);
	assert.deepEqual(checked.unparsable.map(({ file }) => file), ["parses/broken.ts"]);
	assert.equal(checked.lines, 4);
	assert.equal(checked.parsedLines, 2);
	assert.equal((await warnings("parses/broken.ts")).length, 1);
	assert.match((await warnings("parses/broken.ts"))[0].message, /BABLR can't parse this file/u);
	assert.equal((await warnings("parses/fine.ts")).length, 0);

	const again = await session.request("bablr.check", { "path": "parses" }, 120_000);

	assert.equal(again.cached, 2, "both answered from what's kept");

	// Fixed, it parses: its warning goes.
	await session.request("files.write", { "path": "parses/broken.ts", "content": "export const fixed = 2;\n" }, 30_000);

	const fixed = await session.request("bablr.check", { "path": "parses" }, 120_000);

	assert.equal(fixed.parsed, 2);
	assert.equal((await warnings("parses/broken.ts")).length, 0);
	await assert.rejects(session.request("bablr.check", {}, 10_000), /takes \{ path/u);
});
