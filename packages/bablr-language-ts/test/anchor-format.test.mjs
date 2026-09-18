// The ADOPTED annotation anchor: a content-addressed span id with a minimal occurrence tie-breaker (spanAnchors).
// Chosen over both base-anchoring (churns on rebase/force-push — see collab-identity.test.mjs) and content-defined
// chunking (folds in context, so it loses cross-file move and leaks edits across span edges). This suite pins the
// properties that make it the right anchor. Run: node --test (against the built bablr dist).
import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line antfu/no-import-dist -- exercise the shipped artifact (dist is gitignored, local/CI-built)
import { spanAnchors } from "../../bablr/dist/index.js";

/** The Statement-span anchors whose (trimmed) source text matches, in document order. */
const stmts = (src, text) => spanAnchors(src).filter((anchor) => anchor.type === "Statement" && src.slice(anchor.start, anchor.end).trim() === text);
const stmtId = (src, text) => stmts(src, text)[0]?.id;

const BOTTOM = "const bottom = 2";

test("cross-file move: a span keeps its id when moved to another file with different neighbours", () => {
	const fileX = "const x = 1;\nconst bottom = 2;\nconst y = 3;\n";
	const fileY = "function f() {}\nconst bottom = 2;\nreturn 0;\n";

	assert.equal(stmtId(fileX, BOTTOM), stmtId(fileY, BOTTOM), "identical content ⇒ identical id, across files — the move is tracked");
});

test("shift-resistance: editing a DIFFERENT span leaves this one's id untouched", () => {
	const before = "const x = 1;\nconst bottom = 2;\nconst y = 3;\n";
	const after = "const x = 999;\nconst bottom = 2;\nconst y = 3;\n";

	assert.equal(stmtId(before, BOTTOM), stmtId(after, BOTTOM), "an edit elsewhere doesn't change this span's content or id");
});

test("unique content gets a BARE hash (no tie-breaker) so nothing is paid on the common path", () => {
	const id = stmtId("const only = 1;\n", "const only = 1");

	assert.ok(id && !id.includes("#"), "a unique span's id is a bare content hash");
});

test("duplicates: the minimal tie-breaker distinguishes byte-identical spans", () => {
	const dup = "const bottom = 2;\nconst mid = 0;\nconst bottom = 2;\n";
	const both = stmts(dup, BOTTOM);

	assert.equal(both.length, 2, "two identical statements found");
	assert.notEqual(both[0].id, both[1].id, "the duplicates get distinct ids");
	assert.ok(both[0].id.endsWith("#0") && both[1].id.endsWith("#1"), "disambiguated by occurrence ordinal");
	assert.equal(both[0].id.split("#")[0], both[1].id.split("#")[0], "…but they share the same underlying content hash");
});

test("self-edit: editing the annotated span itself changes its id (→ orphan / flag for review)", () => {
	const before = "const x = 1;\nconst bottom = 2;\nconst y = 3;\n";
	const after = "const x = 1;\nconst bottom = 3;\nconst y = 3;\n";

	assert.notEqual(stmtId(before, BOTTOM), stmtId(after, "const bottom = 3"), "a semantic change to the span mints a new id");
});

test("reindent / trivia is insensitive: whitespace changes don't move the id", () => {
	const tight = "const bottom = 2;\n";
	const loose = "  const    bottom   =   2 ;\n";

	assert.equal(stmtId(tight, BOTTOM), stmtId(loose, "const    bottom   =   2"), "trivia-insensitive content ⇒ same id after reindent");
});
