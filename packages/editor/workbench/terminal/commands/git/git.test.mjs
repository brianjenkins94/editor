// `git` through a real just-bash, on isomorphic-git over zen-fs (in memory, as the workspace is in the browser).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fs } from "@zenfs/core";
import { Bash } from "just-bash/browser";

import { commit, hashBlob, readTree, resolveRef, updateIndex } from "isomorphic-git";

import { ensureRepo } from "../../../git-engine.ts";
import { toCommand } from "../../invoke.ts";
import definition from "./command.ts";
import { create } from "./git.ts";

const announced = [];
const bash = new Bash({
	"cwd": "/workspace",
	"customCommands": [toCommand(definition, create({
		"hub": {
			"publish": (subject) => {
				announced.push(subject);
			}
		}
	}))]
});
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
	assert.match((await git("log -n 1")).stdout, /^commit [0-9a-f]{40}\nAuthor: editor <editor@localhost>\n/u);
	assert.equal((await git("log -1 --oneline")).stdout, (await git("log -n 1 --oneline")).stdout, "git's -<number>: -n <number>");
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
	assert.match((await git("push upstream")).stderr, /has origin, where it was loaded from/u);
	assert.match((await git("merge")).stderr, /merging isn't here yet/u);
	assert.match((await git("frobnicate")).stderr, /unknown git command 'frobnicate'/u, "juvy's routing");
	assert.match((await git("stats")).stderr, /Did you mean 'status'\?/u);
	assert.match((await git("status --bogus")).stderr, /Unknown option '--bogus'/u, "juvy's parsing");
	assert.match((await git("--version")).stdout, /^git version isomorphic-git /u);
});

test("switch and checkout: onto a branch, -c / -b making it first with the changes kept", async () => {
	fs.writeFileSync("/workspace/app.ts", "export const answer = 44;\n");
	assert.equal((await git("switch -c refactor")).stderr, "Switched to a new branch 'refactor'\n");
	assert.equal((await git("branch")).stdout, "  feature\n  main\n* refactor\n");
	assert.equal(fs.readFileSync("/workspace/app.ts", "utf8"), "export const answer = 44;\n", "the change is still there");
	await git("commit -a -m 'on refactor'");
	assert.equal((await git("checkout main")).stderr, "Switched to branch 'main'\n");
	assert.equal(fs.readFileSync("/workspace/app.ts", "utf8"), "export const answer = 43 + 0;\n", "main's file");
	assert.match((await git("switch nowhere")).stderr, /invalid reference: nowhere \(git switch -c nowhere makes it/u);
	assert.equal((await git("checkout -b other")).exitCode, 0);
	assert.ok(announced.includes("git.changed"));
});

test("a script HEAD has as executable stays so through an edit: the workspace's filesystem keeps no executable bit", async () => {
	fs.writeFileSync("/workspace/run.sh", "echo one\n");
	await git("add run.sh");
	// (as a clone of a repository with an executable script has it: the index says 100755, the file is 0644)
	await updateIndex({ "fs": fs, "dir": "/workspace", "filepath": "run.sh", "oid": (await hashBlob({ "object": "echo one\n" })).oid, "mode": 0o100755, "add": true });
	await commit({ "fs": fs, "dir": "/workspace", "message": "a script", "author": { "name": "t", "email": "t@t" } });
	fs.writeFileSync("/workspace/run.sh", "echo two\n");
	await git("commit -a -m 'edit the script'");
	const tree = await readTree({ "fs": fs, "dir": "/workspace", "oid": await resolveRef({ "fs": fs, "dir": "/workspace", "ref": "HEAD" }) });

	assert.equal(tree.tree.find((entry) => entry.path === "run.sh")?.mode, "100755");
});
