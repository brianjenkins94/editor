// Identity core: node ids survive reindent + shift, change only where the node itself changed.
// Run: node packages/bablr-language-ts/test/identity.test.mjs  (imports the built bablr dist).
import assert from "node:assert/strict";
import test from "node:test";
// Local integration test against the BUILT bundle (`npm run build` in packages/bablr first): identity.ts pulls in
// the BABLR parser via spans.ts, which only resolves once bundled. dist is gitignored, so this runs locally, not in CI.
// eslint-disable-next-line antfu/no-import-dist -- intentional: exercise the shipped artifact
import { fileDiffIdentity, nodeAtoms, reidentify, reidentifyFromSource } from "../../bablr/dist/index.js";

const atomOf = (nodes, needle) => nodes.find((n) => n.atom.includes(needle));

test("synthetic: a node keeps its id when other nodes are inserted above it (shift)", () => {
	const v1 = ["FunctionDeclaration\t", "Identifier\t\"total\"", "ReturnStatement\t", "Identifier\t\"sum\""];
	const s1 = reidentify(null, v1);
	const returnId = atomOf(s1.nodes, "ReturnStatement").id;

	// insert two nodes at the top; everything below shifts down
	const v2 = ["ImportDeclaration\t", "Identifier\t\"fs\"", ...v1];
	const s2 = reidentify(s1, v2);

	assert.equal(atomOf(s2.nodes, "ReturnStatement").id, returnId, "ReturnStatement id must survive the shift");
	assert.equal(atomOf(s2.nodes, "\"sum\"").id, atomOf(s1.nodes, "\"sum\"").id, "sum id must survive the shift");
	assert.equal(s2.nodes.length, 6);
});

test("synthetic: only the changed node gets a new id; siblings keep theirs", () => {
	const v1 = ["FunctionDeclaration\t", "Identifier\t\"total\"", "ReturnStatement\t", "Identifier\t\"sum\""];
	const s1 = reidentify(null, v1);

	// change the last identifier "sum" -> "total"
	const v3 = ["FunctionDeclaration\t", "Identifier\t\"total\"", "ReturnStatement\t", "Identifier\t\"total\""];
	const s3 = reidentify(s1, v3);

	assert.notEqual(s3.nodes[3].id, s1.nodes[3].id, "the edited node must get a new id");
	assert.equal(atomOf(s3.nodes, "ReturnStatement").id, atomOf(s1.nodes, "ReturnStatement").id, "the sibling keeps its id");
	assert.equal(s3.nodes[0].id, s1.nodes[0].id, "unchanged head keeps its id");
});

test("synthetic: data pinned to a node id resolves after reindent+shift", () => {
	const v1 = ["ReturnStatement\t", "Identifier\t\"sum\""];
	const s1 = reidentify(null, v1);
	const verdicts = new Map();
	verdicts.set(atomOf(s1.nodes, "ReturnStatement").id, "cosmetic");

	const v2 = ["ImportDeclaration\t", ...v1];
	const s2 = reidentify(s1, v2);

	assert.equal(verdicts.get(atomOf(s2.nodes, "ReturnStatement").id), "cosmetic", "annotation follows the node id");
});

test("synthetic: content-addressed insertion ids — same content+place dedups, different place differs", () => {
	const base = reidentify(null, ["A\t", "B\t"]);
	// insert X between A and B, twice from the same base -> same id (dedup)
	const one = reidentify(base, ["A\t", "X\t", "B\t"]);
	const two = reidentify(base, ["A\t", "X\t", "B\t"]);
	assert.equal(atomOf(one.nodes, "X").id, atomOf(two.nodes, "X").id, "same insertion in same place must dedup");
	// insert X at the top instead -> different anchor -> different id
	const three = reidentify(base, ["X\t", "A\t", "B\t"]);
	assert.notEqual(atomOf(three.nodes, "X").id, atomOf(one.nodes, "X").id, "same content, different place -> different id");
});

test("real CST: reindenting + blank lines preserves every node id (trivia-insensitive)", () => {
	const v1 = "function total(items) {\n  let sum = 0;\n  return sum;\n}\n";
	// same code, deeper indentation + a blank line inserted — all whitespace/trivia
	const v1re = "function total(items) {\n\n        let sum = 0;\n        return sum;\n}\n";

	assert.deepEqual(nodeAtoms(v1), nodeAtoms(v1re), "reindent must not change the node atoms");

	const s1 = reidentifyFromSource(null, v1);
	const s2 = reidentifyFromSource(s1, v1re);

	assert.deepEqual(s2.nodes.map((n) => n.id), s1.nodes.map((n) => n.id), "every node id must survive a reindent");
	assert.ok(s1.nodes.length > 3, "sanity: parsed several nodes");
});

test("fileDiffIdentity: verdict is identity-derived (cosmetic / semantic / deletion / unparsable)", () => {
	const base = "function total(items) {\n  let sum = 0;\n  return sum;\n}\n";

	// reindent only -> cosmetic, nothing changed
	const reindent = fileDiffIdentity(base, "function total(items) {\n        let sum = 0;\n        return sum;\n}\n");
	assert.equal(reindent.verdict, "cosmetic");
	assert.equal(reindent.changedNodeIds.length, 0, "no changed nodes for a pure reindent");

	// changed token -> semantic, and the changed node is reported
	const edited = fileDiffIdentity(base, "function total(items) {\n  let sum = 1;\n  return sum;\n}\n");
	assert.equal(edited.verdict, "semantic");
	assert.ok(edited.changedNodeIds.length > 0, "an edit reports changed node ids");

	// pure deletion (removed a statement) is still semantic even though nothing was inserted
	const deleted = fileDiffIdentity(base, "function total(items) {\n  return sum;\n}\n");
	assert.equal(deleted.verdict, "semantic", "a deletion must read semantic");

	// a side that can't parse -> unparsable
	const broken = fileDiffIdentity(base, "function total(items) {\n  let sum = ;;;\n");
	assert.equal(broken.verdict, "unparsable");

	// the snapshot is a real .bablr view: nodes carry ids
	assert.ok(edited.snapshot && edited.snapshot.nodes.length > 0 && edited.snapshot.nodes[0].id.includes(":"));
});

test("real CST: a shift (new statement above) preserves the moved statement's ids", () => {
	const v1 = "function total(items) {\n  let sum = 0;\n  return sum;\n}\n";
	const v2 = "function total(items) {\n  let sum = 0;\n  let doubled = sum * 2;\n  return doubled;\n}\n";
	const s1 = reidentifyFromSource(null, v1);
	const s2 = reidentifyFromSource(s1, v2);

	// the `let sum = 0;` nodes are unchanged and only shifted → their ids carry over
	const sumId = atomOf(s1.nodes, "\"sum\"").id;
	assert.ok(sumId, "found the sum identifier in v1");
	assert.equal(atomOf(s2.nodes, "\"sum\"").id, sumId, "sum's id survives inserting a statement below it");
});
