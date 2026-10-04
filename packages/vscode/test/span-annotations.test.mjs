/**
 * The corpus of edit cases for durable span annotations (SPAN-ANNOTATIONS.md): a span referred to before an edit, the
 * file after it, and where it should land — scored with silo's resolver (util/silo/annotations) over spans BABLR finds.
 * Add a case when a strategy or the policy changes, or when an annotation lands wrong: the bar is that nothing is ever
 * re-placed on its own onto the wrong span (`wrong` stays empty); asking the user is the safe failure.
 *
 * Needs packages/bablr's bundle built (`vite build` there).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluate, referTo, resolve } from "@brianjenkins94/util/silo/annotations";
import { cstSpans, spanAnchors } from "@brianjenkins94/bablr";

/** Every span of `source` as silo's strategies see it: id, node type, offsets, and its tokens. */
function shapesOf(source) {
	const cst = cstSpans(source);
	const tokens = cst.spans.filter((span) => span.token && !span.trivia);

	return spanAnchors(source, "Program", cst).filter((span) => span.type !== null).map((span) => ({ "id": span.id, "type": span.type, "start": span.start, "end": span.end, "atoms": tokens.filter((token) => token.start >= span.start && token.end <= span.end).map((token) => source.slice(token.start, token.end)) }));
}

/** The outermost span exactly covering the first `text` in `source`. */
function spanOf(shapes, source, text) {
	const at = source.indexOf(text);

	return shapes.filter((shape) => shape.start === at && shape.end === at + text.length).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
}

/** An edit case: a reference to `target` in `before`, and the span it should land on in `after` (null: orphaned). */
function edit(name, before, target, after, landsOn) {
	const was = shapesOf(before);
	const now = shapesOf(after);

	return { "name": name, "ref": referTo(was, spanOf(was, before, target).id, "a.js", "blob"), "here": { "file": "a.js", "shapes": now }, "expected": landsOn === null ? null : spanOf(now, after, landsOn).id };
}

const base = "const a = 1;\nsetup();\nfn(foo, bar, baz);\nlog(a);\n";
const cases = [
	edit("an argument edited", base, "fn(foo, bar, baz)", base.replace("baz)", "baz2)"), "fn(foo, bar, baz2)"),
	edit("an unrelated edit above it", base, "fn(foo, bar, baz)", base.replace("= 1", "= 2"), "fn(foo, bar, baz)"),
	edit("moved down past another line", base, "fn(foo, bar, baz)", "const a = 1;\nsetup();\nlog(a);\nfn(foo, bar, baz);\n", "fn(foo, bar, baz)"),
	edit("its statement deleted", base, "fn(foo, bar, baz)", "const a = 1;\nsetup();\nlog(a);\n", null),
	edit("twin calls, one edited", "fn(a, b);\nfn(a, c);\nend();\n", "fn(a, b)", "fn(a, b2);\nfn(a, c);\nend();\n", "fn(a, b2)")
];

test("the default pipeline and policy never re-place an annotation onto the wrong span", () => {
	const result = evaluate(cases);

	assert.deepEqual(result.wrong, [], "nothing silently moved to the wrong place");
	assert.deepEqual(result.right.toSorted(), ["an argument edited", "an unrelated edit above it", "moved down past another line", "twin calls, one edited"].toSorted());
	assert.deepEqual(result.orphanedRight, ["its statement deleted"]);
});

test("a re-placement says which strategy placed it, and how sure it was", () => {
	// BABLR gives the edited call a new id (its content changed: `baz` → `baz2`), so its id alone can't find it.
	assert.notEqual(cases[0].ref.span, cases[0].expected, "fn(foo, bar, baz2) is a different span id than fn(foo, bar, baz)");

	const { status, candidate } = resolve(cases[0].ref, cases[0].here);

	assert.equal(status, "re-placed");
	assert.equal(candidate.strategy, "same shape");
	assert.ok(candidate.score >= 0.85 && candidate.score < 1);
});

test("a call rewritten into something else isn't guessed at: it's asked about or orphaned", () => {
	const rewritten = edit("rewritten", base, "fn(foo, bar, baz)", base.replace("fn(foo, bar, baz)", "other()"), null);
	const { status } = resolve(rewritten.ref, rewritten.here);

	assert.ok(status === "uncertain" || status === "orphaned", status);
});
