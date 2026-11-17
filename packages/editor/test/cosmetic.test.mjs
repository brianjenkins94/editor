// Which changed files the cosmetic extension marks (extensions/cosmetic/verdicts.ts), the editor's git and BABLR answered
// for: each modified code file's verdict, a file BABLR doesn't read left out, and a new reading saying whose mark changed.
// extension.ts asks the editor, after the boot and as changes settle, and draws the marks.
import * as assert from "node:assert/strict";
import { test } from "node:test";

const { changedBetween, verdictsOf } = await import("../extensions/cosmetic/verdicts.ts");

/** The editor, as a reading asks it: `files`' verdicts by path (a path with none, no answer), each modified. */
function answering(files, status = "M") {
	return {
		"status": async () => ({
			"files": Object.keys(files).map((path) => ({ "path": path, "status": status }))
		}),
		"file": async (path) => ({ "head": "before " + path, "working": "after " + path }),
		"classify": async (_head, working) => files[working.slice("after ".length)]
	};
}

test("each modified code file's verdict; a file BABLR doesn't read isn't asked about", async () => {
	assert.deepEqual(Object.fromEntries(await verdictsOf(answering({ "src/a.ts": "cosmetic", "src/b.ts": "semantic", "README.md": "cosmetic" }))), { "src/a.ts": "cosmetic", "src/b.ts": "semantic" });
});

test("a file with no verdict is none; one only added isn't asked about; no status, no reading", async () => {
	assert.deepEqual(Object.fromEntries(await verdictsOf(answering({ "src/a.ts": undefined }))), { "src/a.ts": "none" });
	assert.equal((await verdictsOf(answering({ "src/a.ts": "cosmetic" }, "A"))).size, 0);
	assert.equal(await verdictsOf({
		...answering({}),
		"status": async () => undefined
	}), undefined);
});

test("a new reading says whose mark changed: a verdict changed, a file come or gone", async () => {
	const before = await verdictsOf(answering({ "src/a.ts": "cosmetic", "src/b.ts": "semantic", "src/c.ts": "cosmetic" }));
	const after = await verdictsOf(answering({ "src/a.ts": "semantic", "src/b.ts": "semantic", "src/d.ts": "cosmetic" }));

	assert.deepEqual(changedBetween(before, after).sort(), ["src/a.ts", "src/c.ts", "src/d.ts"]);
});
