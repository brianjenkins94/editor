// Assertions for lib/spans.ts.   node test/spans.mjs
import * as assert from "node:assert/strict";
import { cstSpans } from "../lib/spans";

const find = (spans, type) => spans.filter((s) => s.type === type).map((s) => [s.start, s.end]);

// production names, not sigils; covers flagged and sharing the inner node's span
{
	const { spans } = cstSpans("f(a)");

	assert.deepEqual(find(spans, "CallExpression"), [[0, 4]]);
	assert.deepEqual(find(spans, "Identifier"), [[0, 1], [2, 3]]);
	assert.ok(spans.every((s) => s.type === null || /^[A-Z]/.test(s.type)), "every named span carries a production name");
	assert.ok(spans.some((s) => s.cover && s.type === "Expression" && s.start === 0 && s.end === 4), "the Expression cover wraps the call");
	assert.equal(spans.find((s) => s.field === "openArgumentsToken").type, null, "an anonymous token has no type but keeps its field");
}

// shifted (left-recursive) nodes start at their left operand
{
	const { spans } = cstSpans("a.b(c)");

	assert.deepEqual(find(spans, "MemberExpression"), [[0, 3]]);
	assert.deepEqual(find(spans, "CallExpression"), [[0, 6]]);
	const s2 = cstSpans("x = 1 + 2").spans;

	assert.deepEqual(find(s2, "AssignmentExpression"), [[0, 9]]);
	assert.deepEqual(find(s2, "BinaryExpression"), [[4, 9]]);
	const s3 = cstSpans("f()()").spans;

	assert.deepEqual(find(s3, "CallExpression"), [[0, 3], [0, 5]]);
}

// trivia: comments and whitespace are flagged, code tokens are not
{
	const src = "f(a /* c */, b) // t";
	const { spans } = cstSpans(src);
	const text = (s) => src.slice(s.start, s.end);

	assert.deepEqual(spans.filter((s) => s.token && s.trivia).map(text), [" ", "/*", " c ", "*/", " ", " ", "//", " t"]);
	assert.deepEqual(spans.filter((s) => s.token && !s.trivia).map(text), ["f", "(", "a", ",", "b", ")"]);
}

// offsets are UTF-16 units (tsc's unit) and always add up
for (const src of ["x = \"😀\"; g()", "let 𑈿 = 1 // 😀", `x = \`a\${b}c\` + "\\n"`, ""]) {
	const { spans, length } = cstSpans(src);

	assert.equal(length, src.length, src);
	assert.ok(spans.every((s) => s.start <= s.end && s.end <= src.length));
}

assert.deepEqual(find(cstSpans("x = \"😀\"; g()").spans, "CallExpression"), [[10, 13]]);

console.log("spans: ok");
