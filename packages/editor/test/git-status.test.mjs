/**
 * The working tree's status, walked again only where it changed (workbench/git-engine.ts `status(changed)`): told what
 * was written since, it says what a walk of the whole tree would — and when the index or HEAD has moved (a stage, a
 * commit, anyone's), it walks the whole tree. On zen-fs's in-memory filesystem.
 *
 *   node --import tsx --test test/git-status.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fs } from "@zenfs/core";
import { add, commit } from "isomorphic-git";

const engine = await import("../workbench/git-engine.ts");

const DIR = "/workspace";
const AUTHOR = { "name": "test", "email": "test@localhost" };
/** A status as comparable text, the .gitignore ensureRepo makes aside. */
const said = ({ staged, unstaged }) => JSON.stringify({ "staged": staged.filter(({ path }) => path !== ".gitignore").sort((a, b) => a.path.localeCompare(b.path)), "unstaged": unstaged.filter(({ path }) => path !== ".gitignore").sort((a, b) => a.path.localeCompare(b.path)) });

test("told what changed, status says what a whole walk would — a new file, an edit, a folder gone", async () => {
	await fs.promises.rm(DIR, { "recursive": true, "force": true });
	await fs.promises.mkdir(`${DIR}/dir`, { "recursive": true });
	await engine.ensureRepo();
	await fs.promises.writeFile(`${DIR}/a.txt`, "a\n");
	await fs.promises.writeFile(`${DIR}/dir/x.txt`, "x\n");
	await add({ "fs": fs, "dir": DIR, "filepath": "." });
	await commit({ "fs": fs, "dir": DIR, "message": "first", "author": AUTHOR });
	await engine.status(); // (the walk the next ones build on)

	await fs.promises.writeFile(`${DIR}/b.txt`, "b\n");
	assert.equal(said(await engine.status(["b.txt"])), said(await engine.status()), "a new file");

	await fs.promises.writeFile(`${DIR}/a.txt`, "a, edited\n");
	assert.equal(said(await engine.status(["a.txt"])), said(await engine.status()), "an edit, the new file still there");

	await fs.promises.rm(`${DIR}/dir`, { "recursive": true });

	const incremental = await engine.status(["dir"]);

	assert.equal(said(incremental), said(await engine.status()), "a folder gone");
	assert.ok(incremental.unstaged.some(({ path, status }) => path === "dir/x.txt" && status === "D"));
	assert.ok(incremental.unstaged.some(({ path, status }) => path === "a.txt" && status === "M"));
});

test("when the index has moved since (a stage the working tree didn't say), status walks the whole tree", async () => {
	await fs.promises.rm(DIR, { "recursive": true, "force": true });
	await fs.promises.mkdir(DIR, { "recursive": true });
	await engine.ensureRepo();
	await fs.promises.writeFile(`${DIR}/a.txt`, "a\n");
	await add({ "fs": fs, "dir": DIR, "filepath": "a.txt" });
	await commit({ "fs": fs, "dir": DIR, "message": "first", "author": AUTHOR });
	await fs.promises.writeFile(`${DIR}/a.txt`, "a, edited\n");
	await engine.status();

	// (staged by someone else — the terminal's git, say: nothing here was told)
	await add({ "fs": fs, "dir": DIR, "filepath": "a.txt" });

	const after = await engine.status([]);

	assert.ok(after.staged.some(({ path }) => path === "a.txt"), "the stage shows, though no path was said to change");
	assert.equal(said(after), said(await engine.status()));
});
