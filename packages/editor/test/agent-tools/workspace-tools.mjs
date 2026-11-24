/**
 * Agent workspace tools: the workspace's files read, written, edited, replaced across files, found, searched and
 * deleted (workspace-tools.ts); git's diff, log, show and blame (git-history.ts); and what a terminal printed
 * (`terminal.state`), as debug-mcp's tools ask them (app/tools/; page-tools.test.mjs holds the tools to them).
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/workspace-tools.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("workspace-tools");
const { ask } = session;

test("files: written, read numbered, edited (by text, or by lines), replaced across files or not at all, found, searched (a glob, or a folder's) and deleted", async () => {
	assert.deepEqual(await ask("files.write", { "path": "tools/one.txt", "content": "alpha\nbeta\nalpha\n" }), { "path": "tools/one.txt", "created": true, "lines": 4 });
	await ask("files.write", { "path": "tools/two.txt", "content": "gamma\n" });

	const read = await ask("files.read", { "path": "/workspace/tools/one.txt", "offset": 2, "limit": 1 });

	assert.deepEqual([read.lines, read.from, read.to, read.content, read.dirty], [4, 2, 2, "2\tbeta", false]);
	await assert.rejects(ask("files.read", { "path": "../outside.txt" }), /outside the workspace/u);

	// One match, or say how many; `all` for every one.
	await assert.rejects(ask("files.edit", { "path": "tools/one.txt", "old": "alpha", "new": "ALPHA" }), /2 times/u);
	assert.equal((await ask("files.edit", { "path": "tools/one.txt", "old": "beta", "new": "BETA" })).replaced, 1);
	assert.equal((await ask("files.edit", { "path": "tools/one.txt", "old": "alpha", "new": "ALPHA", "all": true })).replaced, 2);

	// Across files, all or nothing: a preview changes nothing; one edit that doesn't hold, and none is made.
	const edits = [{ "path": "tools/one.txt", "old": "BETA", "new": "beta" }, { "path": "tools/two.txt", "old": "gamma", "new": "GAMMA" }];
	const preview = await ask("files.replace", { "edits": edits, "preview": true });

	assert.equal(preview.replaced, 2);
	assert.match(preview.diff, /-gamma\n\+GAMMA/u);
	await assert.rejects(ask("files.replace", { "edits": [...edits, { "path": "tools/two.txt", "old": "missing", "new": "x" }] }), /nothing was changed/u);
	assert.equal((await ask("files.read", { "path": "tools/two.txt" })).content, "1\tgamma\n2\t");
	assert.equal((await ask("files.replace", { "edits": edits })).replaced, 2);
	assert.deepEqual([(await ask("files.read", { "path": "tools/one.txt" })).content, (await ask("files.read", { "path": "tools/two.txt" })).content], ["1\tALPHA\n2\tbeta\n3\tALPHA\n4\t", "1\tGAMMA\n2\t"]);

	assert.deepEqual((await ask("files.glob", { "pattern": "tools/*.txt" })).files.toSorted(), ["tools/one.txt", "tools/two.txt"]);
	assert.deepEqual(await ask("files.grep", { "pattern": "^ALPHA$", "glob": "tools/**" }), { "matches": [{ "file": "tools/one.txt", "line": 1, "text": "ALPHA" }, { "file": "tools/one.txt", "line": 3, "text": "ALPHA" }], "total": 2 });
	assert.equal((await ask("files.grep", { "pattern": "^ALPHA$", "glob": "tools" })).total, 2, "a folder's name: what's in it");

	// Whole lines by their numbers: what went said, its first and last.
	assert.deepEqual(await ask("files.edit", { "path": "tools/one.txt", "lines": [1, 2], "new": "" }), { "path": "tools/one.txt", "replaced": 1, "lines": 2, "first": "ALPHA", "last": "beta" });
	assert.equal((await ask("files.read", { "path": "tools/one.txt" })).content, "1\tALPHA\n2\t");
	await assert.rejects(ask("files.edit", { "path": "tools/one.txt", "lines": [1, 9], "new": "" }), /has 1 line, not 9/u);

	assert.deepEqual(await ask("files.delete", { "path": "tools" }), { "path": "tools", "folder": true });
	await assert.rejects(ask("files.read", { "path": "tools/one.txt" }), /doesn't exist/u);
	await assert.rejects(ask("files.delete", { "path": ".git" }), /git's own files/u);
});

test("git: a diff of what changed, then the log, a file at a commit and who changed each line", async () => {
	await ask("files.write", { "path": "history.txt", "content": "first\n" });
	await session.request("git.commit", { "message": "history: first", "files": [{ "path": "history.txt" }] }, 60_000);
	await ask("files.write", { "path": "history.txt", "content": "first\nsecond\n" });

	assert.equal((await ask("git.diff", { "path": "history.txt" })).diff, "--- a/history.txt\n+++ b/history.txt\n@@ -1,1 +1,2 @@\n first\n+second\n");

	const [last] = (await ask("git.log", { "path": "history.txt", "limit": 5 })).commits;

	assert.equal(last.message, "history: first");
	assert.deepEqual(await ask("git.show", { "path": "history.txt", "rev": last.short }), { "path": "history.txt", "rev": last.short, "lines": 2, "content": "first\n" });

	const { runs } = await ask("git.blame", { "path": "history.txt" });

	assert.deepEqual(runs.map((run) => [run.from, run.to, run.commit]), [[1, 1, last.short], [2, 2, "working"]]);
});

test("a terminal's output, as it printed it", async () => {
	await session.terminal("echo said-by-the-terminal", { "fresh": true });

	const terminals = await session.eventually("the output", async () => {
		const state = await ask("terminal.state", { "lines": 20 });

		return state.some((each) => each.output.includes("said-by-the-terminal\n")) ? state : undefined;
	}, 30_000);

	assert.ok(terminals.every((each) => typeof each.terminal === "number" && Array.isArray(each.runs)));
});
