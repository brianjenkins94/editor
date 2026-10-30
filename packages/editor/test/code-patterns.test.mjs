// Structural search and rewrite on TypeScript's tree (extensions/history/patterns.ts): a pattern is code, `$X` one
// node, `$$$` a run of a list.
import assert from "node:assert/strict";
import { test } from "node:test";
import ts from "typescript";
import { matchPattern, patternNode, rewrites } from "../extensions/history/patterns.ts";

const sourceOf = (text) => ts.createSourceFile("file.ts", text, ts.ScriptTarget.Latest, true);
const found = (pattern, text) => {
	const source = sourceOf(text);

	return matchPattern(ts, patternNode(ts, pattern), source).map(({ start, end, bindings }) => [source.text.slice(start, end), bindings]);
};

test("a call by its callee and first argument, any arguments after; a string in either quotes", () => {
	const text = "request(\"shell.run\", { command });\nrequest('shell.run');\nrequest(\"files.read\", path);\n";

	assert.deepEqual(found("request(\"shell.run\", $$$)", text).map(([match]) => match), ["request(\"shell.run\", { command })", "request('shell.run')"]);
});

test("$X binds one node, the same text where it's named twice", () => {
	const text = "a.indexOf(b) !== -1;\nitems.indexOf(items) !== -1;\nx.indexOf(y) === -1;\n";

	assert.deepEqual(found("$A.indexOf($B) !== -1", text), [["a.indexOf(b) !== -1", { "A": "a", "B": "b" }], ["items.indexOf(items) !== -1", { "A": "items", "B": "items" }]]);
	assert.deepEqual(found("$A.indexOf($A) !== -1", text).map(([match]) => match), ["items.indexOf(items) !== -1"], "the same text twice");
});

test("whitespace and comments aside; a statement's body as a run", () => {
	const text = "if (ready) {\n\t// go\n\tstart();\n\tlog( 'started' );\n}\n";

	assert.deepEqual(found("if ($C) { $$$BODY }", text).map(([, bindings]) => bindings), [{ "C": "ready", "BODY": "start();\n\tlog( 'started' );" }]);
	assert.equal(found("log('started')", text).length, 1, "whitespace inside a call");
});

test("a rewrite fills its template from the bindings, outermost matches only", () => {
	const text = "const at = list.indexOf(item) !== -1;\nconst nested = f(g(1));\n";
	const source = sourceOf(text);
	const edits = rewrites(matchPattern(ts, patternNode(ts, "$A.indexOf($B) !== -1"), source), "$A.includes($B)");

	assert.deepEqual(edits.map(({ text: replacement }) => replacement), ["list.includes(item)"]);
	assert.equal(rewrites(matchPattern(ts, patternNode(ts, "$F($$$ARGS)"), source), "call($F, $$$ARGS)").length, 2, "f(g(1)) and list.indexOf(item): g(1) is inside f(…)");
});

test("a pattern that isn't one expression or statement says so", () => {
	assert.throws(() => patternNode(ts, "a; b;"), /one expression or one statement/u);
});
