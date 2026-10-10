// The git service's unified diff (git-service.ts unifiedDiff, jsdiff's — debug-mcp's git tool): `git diff`'s hunks, with
// three lines of context.
import { strict as assert } from "node:assert";
import { test } from "node:test";
import { unifiedDiff } from "../git-service.ts";

const lines = (from, to) => Array.from({ "length": to - from + 1 }, (_, index) => String(from + index));

test("a changed line, a removed one and an added one: git's hunks", () => {
	const before = lines(1, 30).join("\n") + "\n";
	const after = [...lines(1, 4), "five", ...lines(6, 19), ...lines(21, 25), "inserted", ...lines(26, 30)].join("\n") + "\n";

	assert.equal(unifiedDiff("x.txt", before, after), [
		"--- a/x.txt",
		"+++ b/x.txt",
		"@@ -2,7 +2,7 @@",
		" 2", " 3", " 4", "-5", "+five", " 6", " 7", " 8",
		"@@ -17,12 +17,12 @@",
		" 17", " 18", " 19", "-20", " 21", " 22", " 23", " 24", " 25", "+inserted", " 26", " 27", " 28",
		""
	].join("\n"));
});

test("a file made, a file deleted, a file unchanged", () => {
	assert.equal(unifiedDiff("new.txt", "", "a\nb\n"), "--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+a\n+b\n");
	assert.equal(unifiedDiff("old.txt", "a\n", ""), "--- a/old.txt\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-a\n");
	assert.equal(unifiedDiff("same.txt", "a\n", "a\n"), "");
	assert.equal(unifiedDiff("one.txt", "a\nb\n", "a\nc\n"), "--- a/one.txt\n+++ b/one.txt\n@@ -1,2 +1,2 @@\n a\n-b\n+c\n");
});
