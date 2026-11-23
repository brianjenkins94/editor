/**
 * The editor's vouches (extensions/history/vouches.ts, packages/silo/README.md *Vouches*): a passing tsval test held to
 * every file of the program's it ran, its own included, each by its contents' git id kept as its digest — what CI can
 * check the same way whatever analyzer it reads the code with. A pass whose run named no file but its own vouches for
 * nothing, nor one whose files can't be read. A dependency's file it ran is held as its package's package.json
 * (`heldAs`), whose bytes change with its version: an upgrade lapses the vouch. editor-api's `latestVouches` keeps the
 * latest of each test's.
 *
 *   node --import tsx --test test/vouches.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { heldAs, reachedBy, vouchesOf } = await import("../extensions/history/vouches.ts");
const { latestVouches } = await import("@brianjenkins94/editor-api/git");
const { digest } = await import("@brianjenkins94/util/silo/graph");

const BLOBS = { "test/math.test.mjs": "blob-test", "src/math.ts": "blob-math" };
const blob = (file) => BLOBS[file];

test("a test is held to each file it ran, its own included, by git id", () => {
	assert.deepEqual(reachedBy(["test/math.test.mjs", "src/math.ts"], blob), { "test/math.test.mjs": digest("blob-test"), "src/math.ts": digest("blob-math") });
	assert.equal(reachedBy(["test/math.test.mjs", "src/gone.ts"], blob), undefined);
});

test("a dependency's file is held as its package's package.json, scoped or not, nested or not", () => {
	assert.equal(heldAs("src/math.ts"), "src/math.ts");
	assert.equal(heldAs("node_modules/semver/functions/parse.js"), "node_modules/semver/package.json");
	assert.equal(heldAs("packages/editor/node_modules/@scope/name/dist/index.js"), "packages/editor/node_modules/@scope/name/package.json");
	assert.equal(heldAs("node_modules/a/node_modules/b/index.js"), "node_modules/a/node_modules/b/package.json");
});

test("passes vouched for on tsval; a failure isn't, and a pass that ran only its own file is unsure", () => {
	const tests = [
		{ "titles": ["adds"], "outcome": "pass", "files": ["test/math.test.mjs", "src/math.ts", "src/math.ts"] },
		{ "titles": ["multiplies"], "outcome": "fail", "files": ["src/math.ts"] },
		{ "titles": ["is true"], "outcome": "pass", "files": ["test/math.test.mjs"] }
	];
	const made = vouchesOf("test/math.test.mjs", tests, (each) => each.files, blob, { "by": "brian", "at": "2026-11-22T20:00:00.000Z" });

	assert.deepEqual(made, {
		"vouches": [{ "test": "test/math.test.mjs › adds", "outcome": "pass", "by": "brian", "at": "2026-11-22T20:00:00.000Z", "runtime": "tsval", "reached": { "test/math.test.mjs": digest("blob-test"), "src/math.ts": digest("blob-math") } }],
		"unsure": ["test/math.test.mjs › is true"]
	});
});

test("a vouches file keeps each test's latest, by test", () => {
	const vouch = (name, at) => ({ "test": name, "outcome": "pass", "by": "brian", "at": at, "runtime": "tsval", "reached": {} });

	assert.deepEqual(latestVouches([vouch("b", "2026-11-22T10:00:00Z"), vouch("a", "2026-11-22T10:00:00Z")], [vouch("b", "2026-11-22T11:00:00Z")]).map((each) => `${each.test} ${each.at}`), ["a 2026-11-22T10:00:00Z", "b 2026-11-22T11:00:00Z"]);
});
