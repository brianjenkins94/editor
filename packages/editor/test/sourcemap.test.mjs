// Reading the dev server's inline source maps back (sourcemap.ts): a generated position to the line it was written on.
import * as assert from "node:assert/strict";
import { test } from "node:test";

import ts from "typescript";

import { addReactRefresh } from "../../almostnode/frameworks/code-transforms.ts";
import { inlineSourceMap, originalPosition } from "../sourcemap.ts";

// Compiled as the preview's dev server compiles it (vite-dev-server.ts's transformCode).
const compile = (source, fileName) => ts.transpileModule(source, { "fileName": fileName, "compilerOptions": { "jsx": ts.JsxEmit.ReactJSX, "module": ts.ModuleKind.ESNext, "target": ts.ScriptTarget.ES2020, "inlineSourceMap": true, "inlineSources": true } }).outputText;

/** The 0-based line and column of `needle` in `text`. */
const find = (text, needle) => {
	const lines = text.split("\n");
	const line = lines.findIndex((candidate) => candidate.includes(needle));

	return { "line": line, "column": lines[line].indexOf(needle) };
};

const SOURCE = [
	"interface Options {",
	"\tlimit: number;",
	"}",
	"",
	"const until: number = performance.now() + 15000;",
	"",
	"export function burnFrame(options: Options): void {",
	"\tconst start = performance.now();",
	"",
	"\twhile (performance.now() - start < options.limit) {",
	"\t\tMath.sqrt(Math.random());",
	"\t}",
	"}",
	""
].join("\n");

test("a compiled position maps back to where it was written, though the types are gone", () => {
	const code = compile(SOURCE, "/workspace/src/burn.ts");
	const map = inlineSourceMap(code);

	assert.ok(map !== undefined);

	const generated = find(code, "Math.sqrt");
	const original = originalPosition(map, generated.line, generated.column);

	assert.notEqual(generated.line, find(SOURCE, "Math.sqrt").line, "the compiled line differs, or this proves nothing");
	assert.deepEqual(original, { "source": "burn.ts", ...find(SOURCE, "Math.sqrt") });
	assert.equal(originalPosition(map, find(code, "function burnFrame").line, 0)?.line, find(SOURCE, "export function burnFrame").line);
});

test("a .tsx module's map still lines up after React Refresh puts its setup in front", () => {
	// eslint-disable-next-line webawesome/no-html-in-strings -- false positive: the TSX source being compiled, not markup we render
	const source = "export function App() {\n\tconst label: string = \"hi\";\n\n\treturn <p>{label}</p>;\n}\n";
	const code = addReactRefresh(compile(source, "/workspace/src/App.tsx"), "/src/App.tsx");
	const generated = find(code, "const label");

	assert.equal(originalPosition(inlineSourceMap(code), generated.line, generated.column)?.line, find(source, "const label").line);
});

test("no map, or a line with no mappings, is no answer", () => {
	assert.equal(inlineSourceMap("console.log(1);"), undefined);
	assert.equal(originalPosition({ "sources": ["a.ts"], "mappings": ";;" }, 1, 0), undefined);
});
