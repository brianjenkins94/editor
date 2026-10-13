// What of a real repository's code the grammar doesn't take yet: each file parsed whole, and each file that fails
// split into its top-level statements (by TypeScript's parser) and those parsed alone, so a failure is named by the
// statement it's in. The tsval corpora (corpus.mjs) are non-module programs; real code is modules, often with JSX.
//
//   tsx test/repo-gaps.mjs <file>...        — prints the failing statements' shapes, most common first
import { readFileSync } from "node:fs";
import { printSource } from "@bablr/agast-helpers/tree";
import { m } from "@bablr/helpers/grammar";
import { treeParse } from "bablr";
import ts from "typescript";
import TypeScript from "../lib/grammar";

function parses(source) {
	try {
		return printSource(treeParse(TypeScript, m`<Program />`, source)) === source;
	} catch {
		return false;
	}
}

function hasJsx(node) {
	return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node) || (ts.forEachChild(node, hasJsx) ?? false);
}

/** A failing statement's shape: its kind, its leading keywords, and whether it holds JSX. */
function shapeOf(statement, text) {
	const head = text.replace(/\s+/gu, " ").match(/^(?:(?:export|default|declare|async|abstract|const|import|type)\b ?)*[^ ({=]*/u)[0].trim();

	return `${ts.SyntaxKind[statement.kind]} · ${head}${hasJsx(statement) ? " · JSX" : ""}`;
}

const files = process.argv.slice(2);
const shapes = new Map();
let whole = 0;

/** Count `file`'s failure under `shape`, with `example` the first time it's seen. */
function count(shape, file, example) {
	const entry = shapes.get(shape) ?? { "count": 0, "files": new Set(), "example": example };

	entry.count += 1;
	entry.files.add(file);
	shapes.set(shape, entry);
}

for (const file of files) {
	const source = readFileSync(file, "utf8");

	if (parses(source)) {
		whole += 1;
	} else {
		const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
		const failing = tree.statements.map((statement) => [statement, source.slice(statement.getStart(tree), statement.end)]).filter(([, text]) => !parses(text + "\n"));

		for (const [statement, text] of failing) {
			count(shapeOf(statement, text), file, text.split("\n")[0].slice(0, 100));
		}

		if (failing.length === 0) {
			count("(every statement parses alone; the file doesn't)", file, file);
		}
	}
}

console.log(`${whole}/${files.length} files parse whole\n`);

for (const [shape, entry] of [...shapes].toSorted((left, right) => right[1].count - left[1].count)) {
	console.log(`${String(entry.count).padStart(4)} in ${String(entry.files.size).padStart(3)} files  ${shape}\n            ${entry.example}`);
}
