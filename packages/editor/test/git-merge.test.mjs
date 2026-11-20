/**
 * A pull that diverged, merged (workbench/git-engine.ts `mergeWith`, git.pull's when a fast-forward can't): the remote's
 * commit made here as another branch and this workspace's own on main, on zen-fs's in-memory filesystem, then the two
 * merged — a merge commit and its files written, or the conflicts written with both sides marked and the merge waiting
 * on the commit that settles them; or nothing touched, saying why.
 *
 *   node --import tsx --test test/git-merge.test.mjs
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { fs } from "@zenfs/core";
import { branch, checkout, commit, readCommit, resolveRef } from "isomorphic-git";

const engine = await import("../workbench/git-engine.ts");

const DIR = "/workspace";
const AUTHOR = { "name": "test", "email": "test@localhost" };

async function write(path, text) {
	await fs.promises.mkdir(`${DIR}/${path.split("/").slice(0, -1).join("/")}`, { "recursive": true });
	await fs.promises.writeFile(`${DIR}/${path}`, text);
}

const read = async (path) => fs.promises.readFile(`${DIR}/${path}`, "utf8").catch(() => undefined);

async function commitAll(message) {
	await engine.stageAll();

	return commit({
		"fs": fs,
		"dir": DIR,
		"message": message,
		"author": AUTHOR
	});
}

const parentsOf = async (ref) => (await readCommit({ "fs": fs, "dir": DIR, "oid": await resolveRef({ "fs": fs, "dir": DIR, "ref": ref }) })).commit.parent;

/** main with a.txt and b.txt; `theirs` one commit on, changing a.txt to `theirsA` and adding c.txt; HEAD on main, as
 *  the base had it. */
async function upstream(theirsA = "one\ntwo, theirs\nthree\n") {
	await fs.promises.rm(DIR, { "recursive": true, "force": true });
	await fs.promises.mkdir(DIR, { "recursive": true });
	await engine.ensureRepo();
	await write("a.txt", "one\ntwo\nthree\n");
	await write("b.txt", "bee\n");

	const base = await commitAll("base");

	await branch({
		"fs": fs,
		"dir": DIR,
		"ref": "theirs",
		"checkout": true
	});
	await write("a.txt", theirsA);
	await write("c.txt", "sea\n");

	const theirs = await commitAll("theirs");

	await checkout({ "fs": fs, "dir": DIR, "ref": "main" });

	return { "base": base, "theirs": theirs };
}

let commits;

beforeEach(async () => {
	commits = await upstream();
});

test("each moved on, different files: a merge commit of both, their files written, nothing left to commit", async () => {
	await write("b.txt", "bee, mine\n");

	const mine = await commitAll("mine");
	const merged = await engine.mergeWith("main", commits.theirs);

	assert.equal(merged.outcome, "merged");
	assert.deepEqual(merged.files.toSorted(), ["a.txt", "c.txt"]);
	assert.deepEqual(await parentsOf("main"), [mine, commits.theirs]);
	assert.deepEqual([await read("a.txt"), await read("b.txt"), await read("c.txt")], ["one\ntwo, theirs\nthree\n", "bee, mine\n", "sea\n"]);
	assert.deepEqual(await engine.status(), { "staged": [], "unstaged": [] });
});

test("each moved on, and a tracked file changed here: nothing touched, commit it first", async () => {
	await write("b.txt", "bee, mine\n");
	await commitAll("mine");
	await write("b.txt", "bee, mine, again\n");

	const head = await resolveRef({ "fs": fs, "dir": DIR, "ref": "main" });
	const merged = await engine.mergeWith("main", commits.theirs);

	assert.equal(merged.outcome, "diverged");
	assert.equal(await resolveRef({ "fs": fs, "dir": DIR, "ref": "main" }), head);
	assert.equal(await read("b.txt"), "bee, mine, again\n");
});

test("the same lines changed on both sides: both marked in the file, and the commit that settles it is the merge", async () => {
	await write("a.txt", "one\ntwo, mine\nthree\n");

	const mine = await commitAll("mine");
	const merged = await engine.mergeWith("main", commits.theirs);

	assert.equal(merged.outcome, "merge conflicts");
	assert.deepEqual(merged.conflicts, ["a.txt"]);
	assert.match(await read("a.txt"), /<<<<<<< main\ntwo, mine\n=======\ntwo, theirs\n>>>>>>> /u);
	assert.equal(await read("c.txt"), "sea\n");
	assert.equal(await engine.mergingIn(), commits.theirs);
	assert.equal(await resolveRef({ "fs": fs, "dir": DIR, "ref": "main" }), mine);

	await write("a.txt", "one\ntwo, both\nthree\n");

	const settled = await engine.commitAll("Merge theirs");

	assert.deepEqual(await parentsOf("main"), [mine, commits.theirs]);
	assert.equal(await resolveRef({ "fs": fs, "dir": DIR, "ref": "main" }), settled.oid);
	assert.equal(await engine.mergingIn(), undefined);
	assert.deepEqual(await engine.status(), { "staged": [], "unstaged": [] });
});

test("a merge given up: every file back as mine, and nothing merging", async () => {
	await write("a.txt", "one\ntwo, mine\nthree\n");

	const mine = await commitAll("mine");

	await engine.mergeWith("main", commits.theirs);
	await engine.abortMerge();

	assert.deepEqual([await read("a.txt"), await read("c.txt")], ["one\ntwo, mine\nthree\n", undefined]);
	assert.equal(await resolveRef({ "fs": fs, "dir": DIR, "ref": "main" }), mine);
	assert.equal(await engine.mergingIn(), undefined);
	await assert.rejects(engine.abortMerge(), /no merge to abort/u);
});

test("an untracked file where theirs adds one: nothing touched, and which file says why", async () => {
	await write("b.txt", "bee, mine\n");
	await commitAll("mine");
	await write("c.txt", "my own sea\n");

	const merged = await engine.mergeWith("main", commits.theirs);

	assert.equal(merged.outcome, "conflicts");
	assert.deepEqual(merged.conflicts, ["c.txt"]);
	assert.equal(await read("c.txt"), "my own sea\n");
});
