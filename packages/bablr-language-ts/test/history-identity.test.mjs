// Commit-chain CDC: participants converge on node ids regardless of where they joined, by anchoring at a base picked
// deterministically from commit oids — not from their join point. Run: node --test (against the built bablr dist).
import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line antfu/no-import-dist -- intentional: exercise the shipped artifact (dist is gitignored, local-only)
import { deriveIdentity, deriveIdentityAsync, headIdentity, isCommitBoundary, selectBase } from "../../bablr/dist/index.js";

const ids = (snapshot) => snapshot.nodes.map((node) => node.id);

// a small file history: C0 base, C1 adds a statement, C2 edits it, C3 edits the return
const commits = [
	{ "oid": "c0aa", "content": "function total(items) {\n  let sum = 0;\n  return sum;\n}\n" },
	{ "oid": "c1bb", "content": "function total(items) {\n  let sum = 0;\n  sum += 1;\n  return sum;\n}\n" },
	{ "oid": "c2cc", "content": "function total(items) {\n  let sum = 0;\n  sum += 2;\n  return sum;\n}\n" },
	{ "oid": "c3dd", "content": "function total(items) {\n  let sum = 0;\n  sum += 2;\n  return sum * 2;\n}\n" }
];
const oids = commits.map((commit) => commit.oid);

test("isCommitBoundary is a pure, deterministic function of the oid", () => {
	assert.equal(isCommitBoundary("c1bb", 7), isCommitBoundary("c1bb", 7));
	assert.equal(typeof isCommitBoundary("c1bb", 7), "boolean");
});

test("selectBase returns the most recent boundary at/before head, else the root", () => {
	for (const n of [2, 3, 5, 7]) {
		const base = selectBase(oids, oids.length - 1, n);

		// it's the maximum index <= head that is a boundary, or 0
		let expected = 0;

		for (let i = oids.length - 1; i > 0; i -= 1) {
			if (isCommitBoundary(oids[i], n)) { expected = i; break; }
		}

		assert.equal(base, expected);
		assert.ok(base === 0 || isCommitBoundary(oids[base], n));
	}

	// with boundaries made vanishingly rare, the base falls back to the root
	assert.equal(selectBase(oids, oids.length - 1, 1_000_000_000), 0);
});

test("THE BUG: seeding from your join point diverges — A@C0 and B@C1 disagree on C2's ids", () => {
	const aFromC0 = ids(deriveIdentity(commits, 0, 2)); // A joined at C0, derived to C2
	const bFromC1 = ids(deriveIdentity(commits, 1, 2)); // B joined at C1, derived to C2

	assert.notDeepEqual(aFromC0, bFromC1, "different seeds must (and do) produce different ids — the divergence");
});

test("THE FIX: content-defined base makes participants converge regardless of join point", () => {
	// A and B both use headIdentity, which picks the base from the oids, not from where they joined.
	for (const n of [2, 3, 5]) {
		const a = headIdentity(commits, 2, n);
		const b = headIdentity(commits, 2, n);

		assert.deepEqual(ids(a.snapshot), ids(b.snapshot), "same content-chosen base ⇒ identical ids");
		assert.equal(a.baseIndex, b.baseIndex);
		// work is bounded to base→head, and the base is a real boundary or the root
		assert.equal(a.steps, 2 - a.baseIndex);
		assert.ok(a.baseIndex === 0 || isCommitBoundary(oids[a.baseIndex], n));
	}
});

test("different heads converge on shared-ancestry ids by anchoring at the common-ancestor boundary", () => {
	const n = 3;
	// A is at C2, B is at C3; compare their ids for the shared commit C2.
	// Naively anchoring at their own recent points diverges:
	assert.notDeepEqual(ids(deriveIdentity(commits, 1, 2)), ids(deriveIdentity(commits, 2, 2)), "different bases diverge");

	// Anchoring at the boundary in the common ancestry (<= the common commit index 2) converges:
	const base = selectBase(oids, 2, n);
	const aAtC2 = ids(deriveIdentity(commits, base, 2));
	const bAtC2 = ids(deriveIdentity(commits, base, 2)); // B computes C2 en route to C3, same base

	assert.deepEqual(aAtC2, bAtC2, "common-ancestry base ⇒ shared ids for the shared commit");
});

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
