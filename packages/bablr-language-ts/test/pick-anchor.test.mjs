// What a range refers to (pickAnchor): a note on a line stands on the statement the line begins, a selection on what
// it selects. Run: node --test (against the built bablr dist).
import assert from "node:assert/strict";
import test from "node:test";
// eslint-disable-next-line antfu/no-import-dist -- exercise the shipped artifact (dist is gitignored, local/CI-built)
import { pickAnchor, spanAnchors } from "../../bablr/dist/index.js";

/** The text of the span `range` refers to. */
function picked(source, start, end) {
	const anchors = spanAnchors(source);
	const id = pickAnchor(anchors, start, end);
	const anchor = anchors.find((each) => each.id === id);

	return anchor === undefined
		? undefined
		: source.slice(anchor.start, anchor.end);
}

/** A whole line, from its first character to its end, as a note with nothing selected asks. */
function line(source, text) {
	const start = source.indexOf(text);

	return [
		start,
		source.indexOf("\n", start)
	];
}

test("a line that begins a statement reaching past it is that statement, not the largest thing inside the line", () => {
	const source = "let total = 0;\nfor (let i = 0; i < 3; i++) {\n\ttotal += i;\n}\n";

	assert.equal(picked(source, ...line(source, "for (")), "for (let i = 0; i < 3; i++) {\n\ttotal += i;\n}");
});

test("a statement on a line of its own is itself", () => {
	const source = "const a = 1;\nconst b = a + 2;\n";

	assert.equal(picked(source, ...line(source, "const b")).replace(/;$/u, ""), "const b = a + 2");
});

test("a selection inside a statement is what it selects, though something larger begins where it does", () => {
	const source = "const c = a + b + d;\n";
	const start = source.indexOf("a + b");

	assert.equal(picked(source, start, start + "a + b".length), "a + b");
});
