// What of a real repository's code the grammar doesn't take yet: each file parsed whole, and each file that fails
// split into its top-level statements (by TypeScript's parser) and those parsed alone, so a failure is named by the
// statement it's in. The tsval corpora (corpus.mjs) are non-module programs; real code is modules, often with JSX.
//
//   tsx test/repo-gaps.mjs <file>...        — prints the failing statements' shapes, most common first
//   tsx test/repo-gaps.mjs --jsonl <file>...  — one line per file as it's done ({ file, ms, ok, failing }), to merge
//                                               from several processes: `--merge <jsonl>...` prints the summary
import { readFileSync } from "node:fs";
import { printSource } from "@bablr/agast-helpers/tree";
import { m } from "@bablr/helpers/grammar";
import { treeParse } from "bablr";
import ts from "typescript";
import TypeScript from "../lib/grammar";
import { parseable } from "../lib/spans";

function parses(source) {
	try {
		return printSource(treeParse(TypeScript, m`<Program />`, parseable(source))) === parseable(source);
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

/** The text a nested node parses as on its own: a statement as it is, a class or interface member inside one. */
function standalone(node, text) {
	if (ts.isClassElement(node)) {
		return `class C {\n${text}\n}\n`;
	}

	if (ts.isTypeElement(node)) {
		return `interface I {\n${text}\n}\n`;
	}

	return text + "\n";
}

/** The innermost statement or member under `node` that doesn't parse on its own (`node` itself when none under it
 *  fails alone): what a failure is really about. */
function narrow(node, tree, source) {
	let found = node;

	const visit = (child) => {
		if (ts.isStatement(child) || ts.isClassElement(child) || ts.isTypeElement(child)) {
			const text = source.slice(child.getStart(tree), child.end);

			if (!parses(standalone(child, text))) {
				found = narrow(child, tree, source);

				return true;
			}

			return false;
		}

		return ts.forEachChild(child, visit);
	};

	ts.forEachChild(node, visit);

	return found;
}

const args = process.argv.slice(2);
const jsonl = args[0] === "--jsonl";
const merge = args[0] === "--merge";
const files = jsonl || merge ? args.slice(1) : args;

/** One file: whether it parses whole, and if not, each top-level statement that doesn't parse alone. */
function check(file) {
	const source = readFileSync(file, "utf8");
	const started = performance.now();

	if (parses(source)) {
		return { "file": file, "ms": Math.round(performance.now() - started), "ok": true, "failing": [] };
	}

	const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, file.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
	const failing = tree.statements
		.map((statement) => [statement, source.slice(statement.getStart(tree), statement.end)])
		.filter(([, text]) => !parses(text + "\n"))
		.map(([statement]) => narrow(statement, tree, source))
		.map((node) => [node, source.slice(node.getStart(tree), node.end)])
		.map(([node, text]) => ({ "shape": shapeOf(node, text), "example": text.replace(/\s+/gu, " ").slice(0, 160) }));

	return { "file": file, "ms": Math.round(performance.now() - started), "ok": false, "failing": failing.length === 0 ? [{ "shape": "(every statement parses alone; the file doesn't)", "example": file }] : failing };
}

const results = merge ? files.flatMap((each) => readFileSync(each, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line))) : [];

if (!merge) {
	for (const file of files) {
		const result = check(file);

		if (jsonl) {
			console.log(JSON.stringify(result));
		} else {
			results.push(result);
		}
	}
}

if (!jsonl) {
	const shapes = new Map();

	for (const { file, failing } of results) {
		for (const { shape, example } of failing) {
			const entry = shapes.get(shape) ?? { "count": 0, "files": new Set(), "example": example };

			entry.count += 1;
			entry.files.add(file);
			shapes.set(shape, entry);
		}
	}

	console.log(`${results.filter((each) => each.ok).length}/${results.length} files parse whole\n`);

	for (const [shape, entry] of [...shapes].toSorted((left, right) => right[1].count - left[1].count)) {
		console.log(`${String(entry.count).padStart(4)} in ${String(entry.files.size).padStart(3)} files  ${shape}\n            ${entry.example}`);
	}

	console.log("\nslowest:");

	for (const { file, ms, ok } of results.toSorted((left, right) => right.ms - left.ms).slice(0, 8)) {
		console.log(`${String(ms).padStart(7)} ms  ${ok ? "ok  " : "FAIL"}  ${file}`);
	}
}
