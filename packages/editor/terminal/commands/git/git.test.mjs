// `git` through a real just-bash, on isomorphic-git over zen-fs (in memory, as the workspace is in the browser).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fs } from "@zenfs/core";
import { Bash } from "just-bash/browser";

import { ensureRepo } from "../../../git-engine.ts";
import { create } from "./git.ts";

const announced = [];
const bash = new Bash({ "cwd": "/workspace", "customCommands": [create({ "hub": { "publish": (subject) => { announced.push(subject); } } })] });
const git = async (line) => bash.exec("git " + line, { "cwd": "/workspace" });

fs.mkdirSync("/workspace", { "recursive": true });
fs.writeFileSync("/workspace/.gitignore", "node_modules/\n");
fs.writeFileSync("/workspace/app.ts", "export const answer = 41;\n");
await ensureRepo();

test("status, add, commit, log: a first commit", async () => {
	assert.match((await git("status")).stdout, /On branch main\nUntracked files:[\s\S]*\tapp\.ts/u);
	assert.equal((await git("add .")).exitCode, 0);
	assert.match((await git("status -s")).stdout, /^A {2}app\.ts$/mu);
	assert.match((await git("commit -m 'the first'")).stdout, /^\[main [0-9a-f]{7}\] the first\n 2 files changed\n$/u);
	assert.match((await git("log --oneline")).stdout, /^[0-9a-f]{7} the first\n$/u);
	assert.match((await git("status")).stdout, /nothing to commit, working tree clean/u);
	assert.ok(announced.length >= 2, "add and commit say the repository changed");
});

// (Each edit changes the file's size: isomorphic-git takes a file whose size and modification second match the index's as
// unchanged — git's "racy git" case, which real git guards against — so a same-size rewrite within the second goes unseen.)
test("diff, then restore undoes it", async () => {
	fs.writeFileSync("/workspace/app.ts", "export const answer = 42; // asked\n");

	const { stdout } = await git("diff");

	assert.match(stdout, /^diff --git a\/app\.ts b\/app\.ts\n/u);
	assert.match(stdout, /^-export const answer = 41;$/mu);
	assert.match(stdout, /^\+export const answer = 42; \/\/ asked$/mu);
	assert.equal((await git("diff --staged")).stdout, "", "nothing staged");
	assert.equal((await git("restore app.ts")).exitCode, 0);
	assert.equal(fs.readFileSync("/workspace/app.ts", "utf8"), "export const answer = 41;\n");
});

test("commit -a takes what's tracked; nothing staged says so", async () => {
	fs.writeFileSync("/workspace/app.ts", "export const answer = 43 + 0;\n");
	fs.writeFileSync("/workspace/new.ts", "new\n");
	assert.match((await git("commit -a -m second")).stdout, / 1 file changed/u, "the change to app.ts, not the untracked file");
	assert.match((await git("commit -m third")).stderr, /nothing added to commit/u);
	assert.match((await git("commit")).stderr, /needs a message/u);
});

test("branch, and what isn't here says what to do", async () => {
	assert.equal((await git("branch")).stdout, "* main\n");
	await git("branch feature");
	assert.equal((await git("branch")).stdout, "  feature\n* main\n");
	assert.match((await git("push")).stderr, /local — the Commit button/u);
	assert.match((await git("frobnicate")).stderr, /not a git command here/u);
	assert.match((await git("--version")).stdout, /^git version isomorphic-git /u);
});
