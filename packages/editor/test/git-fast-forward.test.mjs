/**
 * A fast-forward that keeps the working tree's changes (workbench/git-engine.ts `fastForward`, git.pull's and the
 * Commit button's): the remote's commit made here as another branch, on zen-fs's in-memory filesystem, then the
 * workspace's branch brought up to it — or not, saying why: ahead, diverged, or a file changed on both sides.
 *
 *   node --import tsx --test test/git-fast-forward.test.mjs
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { fs } from "@zenfs/core";
import { branch, checkout, commit, resolveRef } from "isomorphic-git";

const engine = await import("../workbench/git-engine.ts");

const DIR = "/workspace";
const AUTHOR = { "name": "test", "email": "test@localhost" };
const write = async (path, text) => {
	await fs.promises.mkdir(`${DIR}/${path.split("/").slice(0, -1).join("/")}`, { "recursive": true });
	await fs.promises.writeFile(`${DIR}/${path}`, text);
};
// (each edit changes a file's size: isomorphic-git misses a same-size rewrite within the second it was staged, NEXT.md
// *Watching*, "racy git")
const read = async (path) => fs.promises.readFile(`${DIR}/${path}`, "utf8").catch(() => undefined);
const commitAll = async (message) => {
	await engine.stageAll();

	return commit({ "fs": fs, "dir": DIR, "message": message, "author": AUTHOR });
};

/** main with a.txt and src/b.txt; `theirs` one commit on: a.txt changed, src/c.txt added, src/b.txt removed. HEAD on main. */
async function upstream() {
	await fs.promises.rm(DIR, { "recursive": true, "force": true });
	await fs.promises.mkdir(DIR, { "recursive": true });
	await engine.ensureRepo();
	await write("a.txt", "one\n");
	await write("src/b.txt", "bee\n");

	const base = await commitAll("base");

	await branch({ "fs": fs, "dir": DIR, "ref": "theirs", "checkout": true });
	await write("a.txt", "one, then two\n");
	await write("src/c.txt", "sea\n");
	await fs.promises.unlink(`${DIR}/src/b.txt`);

	const theirs = await commitAll("theirs");

	await checkout({ "fs": fs, "dir": DIR, "ref": "main" });

	return { base, theirs };
}

let commits;

beforeEach(async () => {
	commits = await upstream();
});

test("behind: the branch moves to theirs, their files written, a change of mine to another file kept", async () => {
	await write("mine.txt", "mine\n");

	const pulled = await engine.fastForward("main", commits.theirs);

	assert.equal(pulled.outcome, "fast-forwarded");
	assert.deepEqual(pulled.files.toSorted(), ["a.txt", "src/b.txt", "src/c.txt"]);
	assert.equal(await resolveRef({ "fs": fs, "dir": DIR, "ref": "main" }), commits.theirs);
	assert.deepEqual([await read("a.txt"), await read("src/c.txt"), await read("src/b.txt"), await read("mine.txt")], ["one, then two\n", "sea\n", undefined, "mine\n"]);
	// What's changed now is mine alone: theirs is HEAD, staged and on disk as it has it.
	assert.deepEqual((await engine.status()).unstaged.map(({ path }) => path), ["mine.txt"]);
	assert.deepEqual((await engine.status()).staged, []);
});

test("a file changed on both sides: nothing touched, and which files say why", async () => {
	await write("a.txt", "mine\n");

	const pulled = await engine.fastForward("main", commits.theirs);

	assert.equal(pulled.outcome, "conflicts");
	assert.deepEqual(pulled.conflicts, ["a.txt"]);
	assert.equal(await resolveRef({ "fs": fs, "dir": DIR, "ref": "main" }), commits.base);
	assert.deepEqual([await read("a.txt"), await read("src/c.txt")], ["mine\n", undefined]);
});

test("up to date, ahead, diverged: nothing to do, or nothing it can", async () => {
	assert.equal((await engine.fastForward("main", commits.base)).outcome, "up to date");

	await write("a.txt", "mine\n");

	const mine = await commitAll("mine");

	assert.equal((await engine.fastForward("main", commits.base)).outcome, "ahead", "theirs is behind mine: a push is a fast-forward");
	assert.equal((await engine.fastForward("main", commits.theirs)).outcome, "diverged");
	assert.equal(await resolveRef({ "fs": fs, "dir": DIR, "ref": "main" }), mine);
});
