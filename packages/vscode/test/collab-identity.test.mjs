// Collaboration durability suite — the ADOPTED annotation-identity model exercised through REAL git flows
// (isomorphic-git over temp repos). An annotation stores its node id relative to its BASELINE content and RESOLVES on
// open via reidentify(baseline→current) — content-derived, so no oids and no commit-chain CDC anywhere. This is what
// replaced CDC (which converged peers at a shared base but churned ids on rebase/force-push/base-jump).
//
// Invariants: rebase/force-push immune (id is content-derived); new-commit/base-jump carries; merge carries with no
// lineage walk; reset-away nodes orphan cleanly (never misattach); a semantic edit to the annotated span orphans it
// (→ flag) while edits elsewhere carry. Run: node --test (needs bablr/dist built).
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import nodefs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as gitmod from "isomorphic-git";
// eslint-disable-next-line antfu/no-import-dist -- exercise the shipped artifact (dist is gitignored, local/CI-built)
import { nodeAtoms, reidentify } from "../../bablr/dist/index.js";

const git = gitmod.default ?? gitmod;
const FILE = "src/level.ts";
const AUTHOR = { "name": "a", "email": "a@x" };

async function newRepo() {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "collab-"));

	await git.init({ "fs": nodefs, "dir": dir, "defaultBranch": "main" });

	return dir;
}

async function commitFile(dir, content, timestamp) {
	await fs.mkdir(path.join(dir, "src"), { "recursive": true });
	await fs.writeFile(path.join(dir, FILE), content);
	await git.add({ "fs": nodefs, "dir": dir, "filepath": FILE });

	return git.commit({ "fs": nodefs, "dir": dir, "message": "c", "author": timestamp === undefined ? AUTHOR : { ...AUTHOR, "timestamp": timestamp, "timezoneOffset": 0 } });
}

async function headContent(dir) {
	return new TextDecoder().decode((await git.readBlob({ "fs": nodefs, "dir": dir, "oid": await git.resolveRef({ "fs": nodefs, "dir": dir, "ref": "HEAD" }), "filepath": FILE })).blob);
}

/** A node's id relative to a content snapshot (the "baked-in" id at that HEAD). */
const headRelId = (content, fragment) => reidentify(null, nodeAtoms(content)).nodes.find((node) => node.atom.includes(fragment))?.id;

/** Resolve a stored annotation id against current content by reidentifying baseline→current. undefined = orphaned. */
function resolve(storedId, baselineContent, currentContent) {
	return reidentify(reidentify(null, nodeAtoms(baselineContent)), nodeAtoms(currentContent)).nodes.find((node) => node.id === storedId);
}

const FULL = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 6;\n";

test("clone determinism: a clone's identical content yields identical ids, annotations resolve", async () => {
	const dir = await newRepo();

	await commitFile(dir, FULL);
	const cloneDir = await fs.mkdtemp(path.join(os.tmpdir(), "clone-"));

	await fs.cp(dir, cloneDir, { "recursive": true }); // clone copies the object DB → identical content
	assert.equal(await headContent(dir), await headContent(cloneDir), "clone has identical HEAD content");
	assert.equal(headRelId(await headContent(dir), "\"2\""), headRelId(await headContent(cloneDir), "\"2\""), "identical content ⇒ identical ids");
	assert.ok(resolve(headRelId(FULL, "\"2\""), FULL, await headContent(cloneDir)), "annotation resolves in the clone");

	await fs.rm(dir, { "recursive": true, "force": true });
	await fs.rm(cloneDir, { "recursive": true, "force": true });
});

test("rebase / force-push: a content-derived id is immune to oid rewrites", async () => {
	// Same content committed under different times → different oids (the rewrite). The id must be unchanged.
	const r1 = await newRepo();
	const r2 = await newRepo();

	await commitFile(r1, FULL, 1000);
	await commitFile(r2, FULL, 9999);
	assert.notEqual(await git.resolveRef({ "fs": nodefs, "dir": r1, "ref": "HEAD" }), await git.resolveRef({ "fs": nodefs, "dir": r2, "ref": "HEAD" }), "the rewrite produced different oids");
	assert.equal(headRelId(await headContent(r1), "\"2\""), headRelId(await headContent(r2), "\"2\""), "id is content-derived, immune to the oid rewrite");

	await fs.rm(r1, { "recursive": true, "force": true });
	await fs.rm(r2, { "recursive": true, "force": true });
});

test("new commit / base jump: reidentify carries the annotation across a content change", () => {
	const before = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
	const after = "const a = 1;\nconst zzz = 0;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n"; // inserted above + appended below

	assert.ok(resolve(headRelId(before, "\"2\""), before, after), "`b` carries across an insert-above + append-below");
});

test("merge: a branch annotation resolves onto the merge with no lineage walk", async () => {
	const dir = await newRepo();

	await commitFile(dir, "const anchor = 0;\n");
	await git.branch({ "fs": nodefs, "dir": dir, "ref": "feat" });
	await commitFile(dir, "const top = 1;\nconst anchor = 0;\n");
	await git.checkout({ "fs": nodefs, "dir": dir, "ref": "feat" });
	const branchContent = "const anchor = 0;\nconst bottom = 2;\n";

	await commitFile(dir, branchContent);
	await git.checkout({ "fs": nodefs, "dir": dir, "ref": "main" });
	await git.merge({ "fs": nodefs, "dir": dir, "theirs": "feat", "author": AUTHOR, "message": "merge" });

	assert.ok(resolve(headRelId(branchContent, "\"2\""), branchContent, await headContent(dir)), "feat-branch annotation on `bottom` resolves onto the merge");

	await fs.rm(dir, { "recursive": true, "force": true });
});

test("hard reset: a reset-away node orphans cleanly (never misattaches)", () => {
	const truncated = "const a = 1;\nconst b = 2;\nconst c = 3;\n"; // reset away d, e, f
	const eStored = headRelId(FULL, "\"5\"");

	assert.equal(resolve(eStored, FULL, truncated), undefined, "reset-away `e` orphans");
	assert.ok(resolve(headRelId(FULL, "\"2\""), FULL, truncated), "a surviving node still resolves after the reset");
});

test("semantic granularity: a value edit orphans that span; the identifier survives", () => {
	const before = "const b = 2;\n";
	const after = "const b = 3;\n";

	assert.equal(resolve(headRelId(before, "\"2\""), before, after), undefined, "annotation on the value `2` orphans when it becomes `3` (flag for review)");
	assert.ok(resolve(headRelId(before, "\"b\""), before, after), "annotation on the identifier `b` survives the value change");
});
