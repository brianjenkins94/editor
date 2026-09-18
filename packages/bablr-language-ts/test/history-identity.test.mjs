// HEAD→working / baseline→current node identity + the "your edits" chunk grouping. (The commit-chain CDC tests that
// used to live here were removed with the CDC machinery — see collab-identity.test.mjs for the durability evidence.)
// Run: node --test (against the built bablr dist).
import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line antfu/no-import-dist -- intentional: exercise the shipped artifact (dist is gitignored, local-only)
import { deriveIdentityAsync, editGroups } from "../../bablr/dist/index.js";

test("deriveIdentityAsync: nodeLines maps every working node to its line, and a node re-anchors as it shifts", async () => {
	// This is what the comment-annotations surface stands on: a stored note is pinned to a node id, and on reopen we
	// resolve that id → its CURRENT line via nodeLines. Insert a line ABOVE a statement and the SAME id must move down.
	const head = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
	const working = "const a = 1;\nconst inserted = 99;\nconst b = 2;\nconst c = 3;\n";

	const headOnly = await deriveIdentityAsync([head]);
	const derived = await deriveIdentityAsync([head, working]);

	assert.ok(Object.keys(derived.nodeLines).length > 0, "nodeLines is populated");
	assert.ok(Object.values(derived.nodeLines).every((line) => line >= 1 && line <= 4), "every line is within the file");

	// The `const b` value node (`2`) exists in both; its id must survive the insert and re-anchor from line 2 to line 3.
	const bNode = headOnly.snapshot.nodes.find((node) => node.atom.includes("\"2\""));

	assert.ok(bNode !== undefined, "found the const-b value node at HEAD");
	assert.equal(headOnly.nodeLines[bNode.id], 2, "was on line 2 at HEAD");
	assert.equal(derived.nodeLines[bNode.id], 3, "same id re-anchors to line 3 after an insert above — the note follows");
});

test("editGroups: decomposes a burst chain into node-grouped chunks with hover ranges", async () => {
	// The "your edits" timeline: feed [HEAD, …burst afters]; get one merged chunk per changed statement, labelled by
	// its identifier, with the line range the pane highlights on hover. Token-level nodes on a line merge into one chunk.
	const HEAD = "const a = 1;\nconst b = 2;\n";
	const b1 = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
	const b2 = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n";

	const { groups, bursts } = await editGroups([HEAD, b1, b2]);

	assert.equal(bursts, 2, "two bursts counted");
	assert.equal(groups.length, 2, "one chunk per added statement (tokens merged, not one-per-token)");
	assert.deepEqual(groups.map((group) => group.label), ["c", "d"], "each chunk labelled by its identifier");
	assert.deepEqual(groups.map((group) => [group.startLine, group.endLine]), [[3, 3], [4, 4]], "hover ranges are the changed lines");
	assert.ok(groups.every((group) => group.nodeIds.length > 0), "each chunk carries its merged node ids");
	assert.ok(groups.every((group) => group.startLine >= 3), "unchanged lines 1-2 produce no chunk");

	assert.deepEqual((await editGroups([HEAD])).groups, [], "no edits since HEAD → no chunks");

	// Regression: an ADDED file's HEAD side is "" — BABLR can't parse the empty string, and every node is new (incl.
	// the root container). editGroups must not throw, must drop the containers, and must surface per-statement chunks.
	const added = await editGroups(["", "const x = 1;\n", "const x = 1;\nconst y = 2;\n"]);

	assert.equal(added.bursts, 2, "added file: bursts counted across the empty base");
	assert.deepEqual(added.groups.map((group) => group.label), ["x", "y"], "added file: one chunk per statement, not one file-wide blob");

	// Per-chunk burst attribution: a region refined in place across 3 bursts reads as 3 edits (not 1), while a region
	// added once reads as 1 — so the count reflects how much you fussed over each chunk, not just node births.
	const refined = await editGroups(["let z = 0;\n", "let z = 1;\n", "let z = 2;\n", "let z = 3;\n"]);

	assert.equal(refined.groups.length, 1, "the refined line is one chunk");
	assert.equal(refined.groups[0].edits, 3, "refined-in-place across 3 bursts → 3 edits");
	assert.deepEqual(added.groups.map((group) => group.edits), [1, 1], "each once-added statement → 1 edit");
});
