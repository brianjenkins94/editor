/**
 * `silo test` against real git (src/test.ts): a vouch's file held to its git id as the checkout has it, and a test's reach from the vouches at a push's base — each over a repository it makes with git. Real
 * git is the reference, so this runs in Node, not in the editor's debugger (packages/editor/RUNNING.md, *Tests*).
 */
import assert from "node:assert/strict";
import { test } from "node:test";

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

test("a test's reach from a run: the files of its latest editor vouch that held at the push's base, and what the push changed by file", async () => {
	const { filesChangedSince, idsAt, ranReach, vouchesAt } = await import("../src/test.ts");
	const { digest } = await import("@brianjenkins94/util/silo/graph");
	const { execFileSync } = await import("node:child_process");
	const { mkdirSync, mkdtempSync, writeFileSync } = await import("node:fs");
	const { tmpdir } = await import("node:os");
	const path = await import("node:path");
	const repo = mkdtempSync(path.join(tmpdir(), "silo-ran-"));
	const run = (...args: string[]): string => execFileSync("git", args, { "cwd": repo, "encoding": "utf8" }).trim();
	const write = (file: string, text: string): void => {
		mkdirSync(path.dirname(path.join(repo, file)), { "recursive": true });
		writeFileSync(path.join(repo, file), text);
	};

	run("init", "-q");
	run("config", "user.email", "t@localhost");
	run("config", "user.name", "t");
	write("a.mjs", "export const a = 1;\n");
	write("b.mjs", "export const b = 1;\n");
	write("a.test.mjs", "test('adds', () => {});\n");
	run("add", ".");
	run("commit", "-qm", "first");

	const held = (files: string[]): Record<string, string> => Object.fromEntries(files.map((file) => [file, digest(run("hash-object", file))]));
	const vouch = (test: string, at: string, reached: Record<string, string>) => ({ "test": test, "outcome": "pass" as const, "by": "brian", "at": at, "runtime": "tsval", "reached": reached });
	// (a vouch made of the code as it is: what it ran; one of a.mjs before it changed: held to an id a.mjs no longer has)
	const now = vouch("a.test.mjs › adds", "2026-11-22T10:00:00Z", held(["a.test.mjs", "a.mjs"]));
	const stale = vouch("a.test.mjs › other", "2026-11-22T10:00:00Z", { ...held(["a.test.mjs"]), "a.mjs": digest("an older a.mjs") });
	// (a declaration-held vouch, as silo vouch made them, says nothing of what ran)
	const declared = vouch("a.test.mjs › declared", "2026-11-22T10:00:00Z", { "a.mjs#a": "f1" });

	write(".silo/vouches/brian.jsonl", [now, stale, declared].map((each) => JSON.stringify(each) + "\n").join(""));
	run("add", ".");
	run("commit", "-qm", "vouched");

	const base = run("rev-parse", "HEAD");

	// (the push: b.mjs changed, and a newer vouch, made after a.mjs changed in the working tree, kept in its place)
	write("b.mjs", "export const b = 2;\n");
	write(".silo/vouches/brian.jsonl", JSON.stringify(vouch("a.test.mjs › adds", "2026-11-22T12:00:00Z", { ...held(["a.test.mjs"]), "a.mjs": digest("a newer a.mjs") })) + "\n");
	run("commit", "-qam", "the push");

	const then = vouchesAt(repo, base);
	const reach = ranReach(then, idsAt(repo, base, ["a.test.mjs", "a.mjs"]), new Map());

	assert.equal(then.length, 3);
	assert.deepEqual([...reach].map(([test, files]) => [test, [...files].sort()]), [["a.test.mjs › adds", ["a.mjs", "a.test.mjs"]]]);
	assert.deepEqual(filesChangedSince(repo, base), [".silo/vouches/brian.jsonl", "b.mjs"]);
});
