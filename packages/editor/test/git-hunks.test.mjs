// A change as hunks: ids that survive committing another hunk, and a pick of hunks or rows as the text it makes.
// Run: node --import tsx --test test/git-hunks.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { alignedRows, committedContent, hunksOf, rowsOfHunks } from "../shared/git-hunks.ts";

const HEAD = ["one", "two", "three", "four", "five", "six", "seven"].join("\n");
const WORKING = ["one", "TWO", "three", "four", "five", "six", "seven", "eight"].join("\n");

function review(head, working) {
	const rows = alignedRows(head, working);

	return { "rows": rows, "hunks": hunksOf("a.ts", head, working, rows) };
}

test("a file's changes are its hunks: where each is on both sides, what it removes and adds", () => {
	const { hunks } = review(HEAD, WORKING);

	assert.equal(hunks.length, 2);
	assert.deepEqual(hunks.map(({ head, working, removed, added }) => ({ "head": head, "working": working, "removed": removed, "added": added })), [
		{ "head": { "start": 2, "lines": 1 }, "working": { "start": 2, "lines": 1 }, "removed": ["two"], "added": ["TWO"] },
		{ "head": { "start": 7, "lines": 0 }, "working": { "start": 8, "lines": 1 }, "removed": [], "added": ["eight"] }
	]);
	assert.match(hunks[0].id, /^[0-9a-f]{8}$/u);
});

test("committing some hunks leaves the rest in the working tree, under the same ids", () => {
	const { rows, hunks } = review(HEAD, WORKING);
	const [first, second] = hunks;
	const picked = rowsOfHunks("a.ts", hunks, [second.id]);
	const left = new Set(rows.flatMap((row, index) => (row.type !== "ctx" && !picked.has(index) ? [index] : [])));
	const committed = committedContent(HEAD, WORKING, rows, left);

	assert.equal(committed, ["one", "two", "three", "four", "five", "six", "seven", "eight"].join("\n"));

	// HEAD is now what was committed: the hunk not picked is still there, with its id.
	const after = review(committed, WORKING);

	assert.deepEqual(after.hunks.map((hunk) => hunk.id), [first.id]);
});

test("discarding a hunk puts HEAD's lines back and keeps the rest of the change", () => {
	const { rows, hunks } = review(HEAD, WORKING);

	assert.equal(committedContent(HEAD, WORKING, rows, rowsOfHunks("a.ts", hunks, [hunks[0].id])), ["one", "two", "three", "four", "five", "six", "seven", "eight"].join("\n"));
});

test("a deletion is placed after the line it followed; the same change twice is two hunks", () => {
	const head = ["a", "x", "b", "c", "x", "d"].join("\n");
	const { hunks } = review(head, ["a", "b", "c", "d"].join("\n"));

	assert.deepEqual(hunks.map((hunk) => hunk.working), [{ "start": 1, "lines": 0 }, { "start": 3, "lines": 0 }]);
	assert.equal(hunks[1].id, hunks[0].id + "-1");
});

test("a hunk that isn't there now is refused, naming the ones that are", () => {
	const { hunks } = review(HEAD, WORKING);

	assert.throws(() => rowsOfHunks("a.ts", hunks, ["deadbeef"]), /a\.ts has no hunk deadbeef now: review it again/u);
});

test("a rewrite past the diff's limit is one replacement", () => {
	const head = Array.from({ "length": 6000 }, (_, index) => "old " + index).join("\n");
	const working = Array.from({ "length": 6000 }, (_, index) => "new " + index).join("\n");
	const { hunks } = review(head, working);

	assert.equal(hunks.length, 1);
	assert.deepEqual([hunks[0].head.lines, hunks[0].working.lines], [6000, 6000]);
});
