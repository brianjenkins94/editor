/**
 * A comment as a note would take it (extensions/notes/comments.ts): its lines, its text off the markers, the code below it;
 * and the comments that stay, being a tool's or beside code.
 *
 *   node --import tsx --test test/note-comments.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { commentAt } = await import("../extensions/notes/comments.ts");

const lines = (text) => text.split("\n");

test("a run of // lines, from any of them: its text, and the code below it", () => {
	const file = lines("import x from \"x\";\n\n// Retried once: the first read\n// can race the write.\nexport function read() {}\n");

	for (const at of [2, 3]) {
		assert.deepEqual(commentAt(file, at), {
			"from": 2,
			"to": 3,
			"text": "Retried once: the first read\ncan race the write.",
			"below": 4
		});
	}
});

test("a block, JSDoc's or not, from any of its lines: off its markers; past a blank line and a tool's comment to the code", () => {
	const file = lines("/**\n * Why it's a Map:\n * insertion order.\n */\n\n// eslint-disable-next-line no-console\nconst seen = new Map();\n");

	assert.deepEqual(commentAt(file, 1), {
		"from": 0,
		"to": 3,
		"text": "Why it's a Map:\ninsertion order.",
		"below": 6
	});
	assert.deepEqual(commentAt(lines("\t/* one line */\n\tcall();"), 0), {
		"from": 0,
		"to": 0,
		"text": "one line",
		"below": 1
	});
});

test("what stays a comment: a tool's, one beside code, one with no code below, and code itself", () => {
	assert.equal(commentAt(lines("// eslint-disable-next-line no-console\nconsole.log(1);"), 0), undefined);
	assert.equal(commentAt(lines("// @ts-expect-error: untyped\nimport x from \"x\";"), 0), undefined);
	assert.equal(commentAt(lines("/*! @license MIT */\nexport {};"), 0), undefined);
	assert.equal(commentAt(lines("/// <reference types=\"node\" />\nexport {};"), 0), undefined);
	assert.equal(commentAt(lines("call(); /* beside */\nnext();"), 0), undefined);
	assert.equal(commentAt(lines("call();\n// the end"), 1), undefined);
	assert.equal(commentAt(lines("const a = 1;\n"), 0), undefined);
	assert.equal(commentAt(lines("const a = 2\n\t* 3;"), 1), undefined, "a line of code starting with *, no block around it");
});
