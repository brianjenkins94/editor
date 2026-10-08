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
import { atomsOf, cstSpans, follow, spanAnchors } from "@brianjenkins94/bablr";

/** Every span of `source` as silo's strategies see it: id, node type, offsets, and its tokens. */
function shapesOf(source) {
	const cst = cstSpans(source);
	const tokens = cst.spans.filter((span) => span.token && !span.trivia);

	return spanAnchors(source, "Program", cst).filter((span) => span.type !== null).map((span) => ({ "id": span.id, "type": span.type, "start": span.start, "end": span.end, "atoms": tokens.filter((token) => token.start >= span.start && token.end <= span.end).map((token) => token.text) }));
}

/** The outermost span exactly covering the first `text` in `source`. */
function spanOf(shapes, source, text) {
	const at = source.indexOf(text);

	return shapes.filter((shape) => shape.start === at && shape.end === at + text.length).sort((a, b) => (b.end - b.start) - (a.end - a.start))[0];
}

/** Where span `id` of `before` went in `after`, by BABLR's structural diff (what core works out from the baseline). */
function followed(before, after, id) {
	const was = cstSpans(before);
	const now = cstSpans(after);
	const index = spanAnchors(before, "Program", was).findIndex((span) => span.id === id);
	const found = index === -1 ? undefined : follow(atomsOf(was), atomsOf(now), index);

	return found === undefined ? undefined : { "id": spanAnchors(after, "Program", now)[found.to].id, "how": found.how };
}

/** An edit case: a reference to `target` in `before`, and the span it should land on in `after` (null: orphaned).
 *  With `baseline`, the baseline is available, so the structural diff can follow the span. */
function edit(name, before, target, after, landsOn, { baseline = false } = {}) {
	const was = shapesOf(before);
	const now = shapesOf(after);
	const ref = referTo(was, spanOf(was, before, target).id, "a.js", "blob");

	return { "name": name, "ref": ref, "here": { "file": "a.js", "shapes": now, ...baseline ? { "reidentified": followed(before, after, ref.span) } : {} }, "expected": landsOn === null ? null : spanOf(now, after, landsOn).id };
}

const tick = "function tick(n) {\n  move(n);\n  draw();\n}\nstart();\n";
const rewritten = tick.replace("  move(n);\n  draw();", "  const m = n * 2;\n  move(m);\n  render(m);\n  log(m);");

const base = "const a = 1;\nsetup();\nfn(foo, bar, baz);\nlog(a);\n";
const cases = [
	edit("an argument edited", base, "fn(foo, bar, baz)", base.replace("baz)", "baz2)"), "fn(foo, bar, baz2)"),
	edit("an unrelated edit above it", base, "fn(foo, bar, baz)", base.replace("= 1", "= 2"), "fn(foo, bar, baz)"),
	edit("moved down past another line", base, "fn(foo, bar, baz)", "const a = 1;\nsetup();\nlog(a);\nfn(foo, bar, baz);\n", "fn(foo, bar, baz)"),
	edit("its statement deleted", base, "fn(foo, bar, baz)", "const a = 1;\nsetup();\nlog(a);\n", null),
	edit("twin calls, one edited", "fn(a, b);\nfn(a, c);\nend();\n", "fn(a, b)", "fn(a, b2);\nfn(a, c);\nend();\n", "fn(a, b2)"),
	// With the baseline, the structural diff follows a span whose id changed.
	edit("re-identified: an argument added", base, "fn(foo, bar, baz)", base.replace("baz)", "baz, qux)"), "fn(foo, bar, baz, qux)", { "baseline": true }),
	edit("re-identified: a function's body rewritten", tick, tick.slice(0, tick.indexOf("\nstart")), rewritten, rewritten.slice(0, rewritten.indexOf("\nstart")), { "baseline": true }),
	edit("re-identified: its statement deleted", base, "fn(foo, bar, baz)", "const a = 1;\nsetup();\nlog(a);\n", null, { "baseline": true })
];

test("the default pipeline and policy never re-place an annotation onto the wrong span", () => {
	const result = evaluate(cases);

	assert.deepEqual(result.wrong, [], "nothing silently moved to the wrong place");
	assert.deepEqual(result.right.toSorted(), ["an argument edited", "an unrelated edit above it", "moved down past another line", "twin calls, one edited", "re-identified: an argument added", "re-identified: a function's body rewritten"].toSorted());
	assert.deepEqual(result.orphanedRight.toSorted(), ["its statement deleted", "re-identified: its statement deleted"].toSorted());
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

test("the structural diff matches a call by its type, so one replaced by another call is asked about, not followed", () => {
	const replaced = edit("replaced", base, "fn(foo, bar, baz)", base.replace("fn(foo, bar, baz)", "other(1)"), "other(1)", { "baseline": true });
	const { status, candidate } = resolve(replaced.ref, replaced.here);

	assert.equal(replaced.here.reidentified?.how, "kept", "the diff does follow it there");
	assert.equal(status, "uncertain", "but too little of its head survived to re-place it on its own");
	assert.equal(candidate.strategy, "re-identified");
});

test("a function whose body was rewritten is followed by the diff — its name and signature survived", () => {
	const { status, candidate } = resolve(cases[6].ref, cases[6].here);

	assert.equal(status, "re-placed");
	assert.equal(candidate.strategy, "re-identified");
});

test("the typed strategy lifts a shape match whose types agree, drops one whose types don't, and leaves the rest as the shape had it", () => {
	const shaped = edit("arguments renamed", base, "fn(foo, bar, baz)", base.replace("fn(foo, bar, baz)", "fn(qux, quux, baz)"), "fn(qux, quux, baz)");
	const target = shaped.expected;
	const typedRef = { ...shaped.ref, "inferred": "number", "observed": ["number"] };
	const typesOf = (inferred, observed) => (id) => (id === target ? { "inferred": inferred, "observed": observed } : undefined);

	assert.equal(resolve(shaped.ref, shaped.here).status, "uncertain", "by shape alone, it's asked about");
	assert.equal(resolve(typedRef, shaped.here).status, "uncertain", "types on one side only change nothing");

	const agree = resolve(typedRef, { ...shaped.here, "types": typesOf("number", ["number"]) });

	assert.deepEqual([agree.status, agree.candidate.span, agree.candidate.strategy], ["re-placed", target, "typed"]);
	assert.equal(resolve(typedRef, { ...shaped.here, "types": typesOf("string", ["string"]) }).status, "orphaned", "its types disagree: not this one");
	assert.equal(resolve({ ...shaped.ref, "inferred": "any" }, { ...shaped.here, "types": typesOf("any") }).status, "uncertain", "any matching any says nothing");
});
