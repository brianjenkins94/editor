/**
 * `silo test`'s reading back (src/test.ts): what silo's reporter wrote in a CI's log, as each test's outcome, and each
 * test's standing by its file and titles, the job's name off.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { reportedIn, standingsByTest } from "../src/test.ts";

test("silo's reporter's lines in a log, timestamps, pnpm's prefix and all: each test its file first, the rest of the log left", () => {
	const log = [
		"2026-11-22T18:00:00.0000000Z ✔ adds (0.3ms)",
		"2026-11-22T18:00:00.0000001Z silo:test {\"file\":\"packages/editor/test/add.test.mjs\",\"titles\":[\"adds\"],\"outcome\":\"pass\",\"ms\":0.3}",
		"2026-11-22T18:00:00.0000002Z packages/editor test: silo:test {\"file\":\"packages/editor/test/add.test.mjs\",\"titles\":[\"a suite\",\"fails\"],\"outcome\":\"fail\"}",
		"silo:test {not json",
		"silo:test {\"titles\":[\"no file\"],\"outcome\":\"pass\"}"
	].join("\n");

	assert.deepEqual(reportedIn(log), [
		{ "titles": ["packages/editor/test/add.test.mjs", "adds"], "outcome": "pass", "ms": 0.3 },
		{ "titles": ["packages/editor/test/add.test.mjs", "a suite", "fails"], "outcome": "fail" }
	]);
});

test("a test's standing over CI's runs, by its file and titles: the job's name off", () => {
	const run = (id: string, outcome: "pass" | "fail", at: string) => ({ "id": id, "commit": id, "at": at, "attempts": [{ "attempt": 1, "jobs": [{ "name": "build-lint (test)", "conclusion": "success", "tests": [{ "titles": ["packages/editor/test/add.test.mjs", "adds"], "outcome": outcome }] }] }] });
	const known = standingsByTest([run("2", "pass", "2026-11-22T10:00:00Z"), run("1", "fail", "2026-11-21T10:00:00Z")]);
	const standing = known.get("packages/editor/test/add.test.mjs › adds");

	assert.deepEqual([...known.keys()], ["packages/editor/test/add.test.mjs › adds"]);
	assert.equal(standing?.runs, 2);
	assert.equal(standing?.last.verdict, "pass");
	assert.equal(standing?.lastFailed?.verdict, "fail");
});

test("a pass vouched for with what its file reaches, as fingerprinted now; a failure vouches for nothing", async () => {
	const { vouchesFor } = await import("../src/test.ts");
	const edges: Record<string, string[]> = { "a.test.mjs#(top)": ["a.mjs#a"] };
	const graph = { "fingerprints": new Map([["a.test.mjs#(top)", "t"], ["a.mjs#a", "f1"], ["b.mjs#b", "f2"]]), "nodes": () => Object.keys(edges), "edges": (id: string) => edges[id] ?? [] };
	const made = vouchesFor([{ "titles": ["a.test.mjs", "adds"], "outcome": "pass" }, { "titles": ["a.test.mjs", "fails"], "outcome": "fail" }], graph, { "by": "brian", "runtime": "node", "at": "2026-11-22T18:00:00.000Z" });

	assert.deepEqual(made, [{ "test": "a.test.mjs › adds", "outcome": "pass", "by": "brian", "at": "2026-11-22T18:00:00.000Z", "runtime": "node", "reached": { "a.test.mjs#(top)": "t", "a.mjs#a": "f1" } }]);
});
