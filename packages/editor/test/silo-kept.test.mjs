/**
 * The files the editor makes for a project (`.silo/versions.json`, `baseline.json`, `capabilities.json`) are the
 * repository's once it has committed them, and local until then (editor-api's git.ts `keptAt`): loading a repository
 * doesn't put them in its next commit. And one an earlier editor wrote at `.silo/` untracked is moved to its local copy
 * as the workspace becomes a repository (git-engine.ts `includeSilo`), on zen-fs's in-memory filesystem.
 *
 *   node --import tsx --test test/silo-kept.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { fs } from "@zenfs/core";
import { add, commit } from "isomorphic-git";

const { keptAt, localOf } = await import("../../editor-api/src/git.ts");
const engine = await import("../workbench/git-engine.ts");

const DIR = "/workspace";
/** What's changed under .silo/ (the workspace's own .gitignore, ensureRepo's, aside). */
const silo = (changes) => changes.map(({ path }) => path).filter((path) => path.startsWith(".silo/"));

test("where a kept file is: at .silo/ when the repository has it there, else in .silo/local/", async () => {
	assert.equal(localOf(".silo/versions.json"), ".silo/local/versions.json");
	assert.equal(await keptAt(".silo/versions.json", () => true), ".silo/versions.json");
	assert.equal(await keptAt(".silo/baseline.json", async () => false), ".silo/local/baseline.json");
});

test("an untracked kept file at .silo/ moves to its local copy; a committed one stays, and git sees neither move", async () => {
	await fs.promises.rm(DIR, { "recursive": true, "force": true });
	await fs.promises.mkdir(`${DIR}/.silo`, { "recursive": true });
	await engine.ensureRepo();
	await fs.promises.writeFile(`${DIR}/.silo/baseline.json`, "{ \"shared\": true }\n");
	await add({ "fs": fs, "dir": DIR, "filepath": ".silo/baseline.json" });
	await commit({ "fs": fs, "dir": DIR, "message": "the repository shares its baseline", "author": { "name": "test", "email": "test@localhost" } });
	await fs.promises.writeFile(`${DIR}/.silo/versions.json`, "{ \"from\": \"an earlier editor\" }\n");

	await engine.includeSilo();

	assert.equal(fs.existsSync(`${DIR}/.silo/versions.json`), false);
	assert.equal(await fs.promises.readFile(`${DIR}/.silo/local/versions.json`, "utf8"), "{ \"from\": \"an earlier editor\" }\n");
	assert.equal(await fs.promises.readFile(`${DIR}/.silo/baseline.json`, "utf8"), "{ \"shared\": true }\n", "committed: the repository's");
	assert.deepEqual(silo((await engine.status()).unstaged), [], "nothing for a commit: .silo/local/ is git's to ignore, by .git/info/exclude");
	assert.equal(fs.existsSync(`${DIR}/.silo/.gitignore`), false, "and .silo/ has nothing new of its own for it");
	assert.match(await fs.promises.readFile(`${DIR}/.git/info/exclude`, "utf8"), /^\/\.silo\/local\/$/mu);
});

test(".silo/'s own .gitignore goes into a commit only with something else under .silo/", async () => {
	await engine.commitAll("the workspace's .gitignore"); // (ensureRepo's: what else there was to commit)
	await fs.promises.writeFile(`${DIR}/.silo/.gitignore`, "/local/\n");
	await assert.rejects(engine.commitAll("only the seed"), /nothing to commit/u, "alone, it's nothing to commit");

	await fs.promises.writeFile(`${DIR}/notes.txt`, "a change\n");
	await engine.commitAll("a change elsewhere");
	assert.deepEqual(silo((await engine.status()).unstaged), [".silo/.gitignore"], "left out beside a change elsewhere");

	await fs.promises.mkdir(`${DIR}/.silo/runs`, { "recursive": true });
	await fs.promises.writeFile(`${DIR}/.silo/runs/someone.jsonl`, "{}\n");
	await engine.commitAll("a run");
	assert.deepEqual(silo((await engine.status()).unstaged), [], "with a run under .silo/, it goes too");
});
