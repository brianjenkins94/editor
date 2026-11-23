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
	const { digest } = await import("@brianjenkins94/util/silo/graph");
	const edges: Record<string, string[]> = { "a.test.mjs#(top)": ["a.mjs#a"] };
	const graph = { "fingerprints": new Map([["a.test.mjs#(top)", "t"], ["a.mjs#a", "f1"], ["b.mjs#b", "f2"]]), "nodes": () => Object.keys(edges), "edges": (id: string) => edges[id] ?? [] };
	const made = vouchesFor([{ "titles": ["a.test.mjs", "adds"], "outcome": "pass" }, { "titles": ["a.test.mjs", "fails"], "outcome": "fail" }], graph, { "by": "brian", "runtime": "node", "at": "2026-11-22T18:00:00.000Z" });

	assert.deepEqual(made, [{ "test": "a.test.mjs › adds", "outcome": "pass", "by": "brian", "at": "2026-11-22T18:00:00.000Z", "runtime": "node", "reached": { "a.test.mjs#(top)": digest("t"), "a.mjs#a": digest("f1") } }]);
});

test("another runtime's vouch counts for a test CI passed after it was made (decision 19), not before, nor one CI failed", async () => {
	const { agreedOn } = await import("../src/test.ts");
	const standing = (id: string, verdict: "pass" | "fail", at: string) => [id, { "id": id, "runs": 3, "last": { "verdict": verdict, "run": "1", "commit": "c", "at": at }, "flakes": 0, "streak": { "verdict": verdict, "runs": 3 } }] as const;
	const vouch = (test: string, at: string, runtime = "tsval") => ({ "test": test, "outcome": "pass" as const, "by": "brian", "at": at, "runtime": runtime, "reached": {} });
	const standings = new Map([standing("a", "pass", "2026-11-22T12:00:00Z"), standing("b", "pass", "2026-11-22T12:00:00Z"), standing("c", "fail", "2026-11-22T12:00:00Z"), standing("d", "pass", "2026-11-22T12:00:00Z")]);

	assert.deepEqual([...agreedOn([vouch("a", "2026-11-22T11:00:00Z"), vouch("b", "2026-11-22T13:00:00Z"), vouch("c", "2026-11-22T11:00:00Z"), vouch("d", "2026-11-22T11:00:00Z", "node"), vouch("e", "2026-11-22T11:00:00Z")], standings, "node")], ["a"]);
});

test("a vouch's file outside the graph is held to its contents' git id as the checkout has it", async () => {
	const { filesNamedIn } = await import("../src/test.ts");
	const { execFileSync } = await import("node:child_process");
	const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const path = await import("node:path");
	const repo = mkdtempSync(path.join(tmpdir(), "silo-vouch-"));

	execFileSync("git", ["init", "-q"], { "cwd": repo });
	writeFileSync(path.join(repo, "a.test.mjs"), "test('adds', () => {});\n");
	// (a dependency it ran, installed and ignored: held by its package.json, which changes with its version)
	writeFileSync(path.join(repo, ".gitignore"), "node_modules/\n");
	mkdirSync(path.join(repo, "node_modules", "twice"), { "recursive": true });
	writeFileSync(path.join(repo, "node_modules", "twice", "package.json"), "{ \"name\": \"twice\", \"version\": \"1.0.0\" }\n");

	const reached = { "a.test.mjs": "x", "a.mjs#a": "f1", "gone.mjs": "y", "node_modules/twice/package.json": "z" };
	const named = filesNamedIn(repo, [{ "test": "a.test.mjs › adds", "outcome": "pass", "by": "brian", "at": "2026-11-22T11:00:00Z", "runtime": "tsval", "reached": reached }]);

	const oid = (file: string): string => execFileSync("git", ["hash-object", file], { "cwd": repo, "encoding": "utf8" }).trim();

	assert.deepEqual([...named], [["a.test.mjs", oid("a.test.mjs")], ["node_modules/twice/package.json", oid("node_modules/twice/package.json")]]);
});

test("silo vouch holds a test to the lockfiles over it, so a dependency's upgrade lapses it", async () => {
	const { lockfilesOver } = await import("../src/test.ts");
	const { digest } = await import("@brianjenkins94/util/silo/graph");
	const { execFileSync } = await import("node:child_process");
	const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const path = await import("node:path");
	const repo = mkdtempSync(path.join(tmpdir(), "silo-locks-"));

	execFileSync("git", ["init", "-q"], { "cwd": repo });
	mkdirSync(path.join(repo, "packages", "a", "test"), { "recursive": true });
	writeFileSync(path.join(repo, "package-lock.json"), "{}\n");
	writeFileSync(path.join(repo, "packages", "a", "pnpm-lock.yaml"), "lockfileVersion: 9\n");

	const oid = (file: string): string => digest(execFileSync("git", ["hash-object", file], { "cwd": repo, "encoding": "utf8" }).trim());

	assert.deepEqual(lockfilesOver(repo, "packages/a/test/a.test.mjs"), { "packages/a/pnpm-lock.yaml": oid("packages/a/pnpm-lock.yaml"), "package-lock.json": oid("package-lock.json") });
	assert.deepEqual(lockfilesOver(repo, "b.test.mjs"), { "package-lock.json": oid("package-lock.json") });
});
