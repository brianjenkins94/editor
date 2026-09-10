/**
 * TypeScript's own compiler tests (`tests/cases/{compiler,conformance}`, Apache-2.0) as differential
 * INPUTS — ASSIGNMENT §5 S0 item 2. They test the *compiler* (types, errors, emit), so they carry no
 * runtime expectations; what they offer is ~12k real TypeScript programs to run through tsval and
 * through tsc-emit-then-Node and compare (the oracle). The supported-surface policy is applied as a
 * filter: single-file, non-module, syntactically clean programs within the erasable-TypeScript surface.
 *
 * Case format: `// @option: value` header lines (any case) and `// @filename: x.ts` blocks for
 * multi-file tests. Two roots: `vendor/typescript-cases-sample/` (checked in, 1-in-10 of the eligible
 * cases, run by `npm test`) and `vendor/typescript-cases/` (the full pinned checkout, gitignored,
 * `npm run ts-cases:fetch`) for `npm run ts-cases:report`.
 */
// eslint-disable-next-line ts/no-restricted-imports -- sync fs.readdirSync (a lazy generator walk) has no equivalent in the async-only util/fs wrapper
import fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

export const TS_CASES_PIN = "v5.9.3";
export const FULL_ROOT = path.resolve(import.meta.dirname, "../../vendor/typescript-cases");
export const SAMPLE_ROOT = path.resolve(import.meta.dirname, "../../vendor/typescript-cases-sample");

export interface TsCase {
	/** path relative to `tests/cases/`, e.g. `compiler/foo.ts` — the stable id. */
	"id": string;
	/** `// @option: value` headers, keys lower-cased. */
	"options": Record<string, string>;
	/** the case's files (`@filename` blocks); a single unnamed block for the common one-file case. */
	"files": { "name": string; "text": string }[];
	/** the raw source. */
	"source": string;
}

const HEADER = /^\/\/\s*@(\w+)\s*:\s*(.*)$/;

/** Split a case into its header options and `@filename` blocks (header lines are kept in the text: they are comments). */
export function parseCase(id: string, source: string): TsCase {
	const options: Record<string, string> = {};
	const files: { "name": string; "text": string }[] = [];
	let current: { "name": string; "text": string } | undefined;

	for (const line of source.split("\n")) {
		const match = HEADER.exec(line);

		if (match !== null) {
			const key = match[1].toLowerCase();
			const value = match[2].trim();

			if (key === "filename") {
				current = { "name": value, "text": "" };
				files.push(current);
				continue;
			}

			if (current === undefined) {
				options[key] = value;
			} else {
				current.text += line + "\n"; // an option inside a file block belongs to that file's text
			}

			continue;
		}

		if (current === undefined) {
			if (line.trim() === "") {
				continue; // leading blank lines before the first block
			}

			current = { "name": "", "text": "" };
			files.push(current);
		}

		current.text += line + "\n";
	}

	if (files.length === 0) {
		files.push({ "name": "", "text": "" });
	}

	return { "id": id, "options": options, "files": files, "source": source };
}

export function hasCorpus(root: string): boolean {
	return fs.existsSync(path.join(root, "tests/cases/compiler")) && fs.existsSync(path.join(root, "LICENSE.txt"));
}

/** Every case under `<root>/tests/cases/{compiler,conformance}`, in stable sorted order. */
export function *loadTsCases(root: string, filter?: (id: string) => boolean): Generator<TsCase> {
	if (!hasCorpus(root)) {
		return;
	}

	const base = path.join(root, "tests/cases");

	function *walk(dir: string): Generator<string> {
		if (!fs.existsSync(dir)) {
			return;
		}

		for (const entry of fs.readdirSync(dir, { "withFileTypes": true }).sort((left, right) => left.name.localeCompare(right.name))) {
			const full = path.join(dir, entry.name);

			if (entry.isDirectory()) {
				yield* walk(full);
			} else if (/\.tsx?$/.test(entry.name)) {
				yield full;
			}
		}
	}

	for (const sub of ["compiler", "conformance"]) {
		for (const file of walk(path.join(base, sub))) {
			const id = path.relative(base, file).split(path.sep).join("/");

			if (filter !== undefined && !filter(id)) {
				continue;
			}

			yield parseCase(id, fs.readFileSync(file, "utf8"));
		}
	}
}

// --- the policy, as a filter ---------------------------------------------------------------------

const MODULE_CODE = /^\s*(import\s|export\s|\/\/\/\s*<reference)|\bimport\s*\(|\brequire\s*\(|\bmodule\.exports\b|\bexports\.\w+\s*=/m;
const NON_DETERMINISTIC = /\bMath\.random\b|\bDate\.now\b|\bnew\s+Date\s*\(|\bperformance\.now\b/;
/** Names a script's top-level `var` may re-declare without effect (a var over an existing global keeps
 *  its value), where tsval's module scope would shadow them — a script-vs-module difference, skipped. */
const GLOBAL_NAMES = new Set(Object.getOwnPropertyNames(globalThis));

/** Why a case is outside what tsval runs (undefined when it is eligible). */
export function policySkip(test: TsCase): string | undefined {
	if (test.files.length > 1) {
		return "multi-file test (a module graph)";
	}

	const [{ name }] = test.files;

	if (/\.tsx$/i.test(test.id) || /\.tsx$/i.test(name) || "jsx" in test.options) {
		return "JSX";
	}

	if (/\.d\.ts$/i.test(name)) {
		return "declaration file (no runtime)";
	}

	if (/\.jsx?$/i.test(name) || "allowjs" in test.options || "checkjs" in test.options) {
		return "JavaScript-with-JSDoc test (type-level)";
	}

	const code = test.files[0].text;

	if (MODULE_CODE.test(code)) {
		return "module code (out of scope: tsval runs a program)";
	}

	if (/\beval\s*\(|\bnew\s+Function\s*\(|\bFunction\s*\(/.test(code)) {
		return "uses eval/Function (code-from-string is a capability shim, not modeled)";
	}

	if (NON_DETERMINISTIC.test(code)) {
		return "non-deterministic (Math.random / Date): the two sides cannot agree";
	}

	const sf = ts.createSourceFile(name || "case.ts", code, ts.ScriptTarget.Latest, true);
	const parseDiagnostics = (sf as unknown as { "parseDiagnostics"?: unknown[] }).parseDiagnostics ?? [];

	if (parseDiagnostics.length > 0) {
		return "parser test (syntactic errors)";
	}

	let reason: string | undefined;

	for (const statement of sf.statements) {
		// Ambient declarations promise host bindings the oracle cannot provide; a case that then uses
		// them fails on both sides for no interesting reason (or trips node:vm's own quirks).
		if ((ts.getCombinedModifierFlags(statement as unknown as ts.Declaration) & ts.ModifierFlags.Ambient) !== 0 && !ts.isModuleDeclaration(statement) && !ts.isInterfaceDeclaration(statement) && !ts.isTypeAliasDeclaration(statement)) {
			return "ambient host bindings (`declare var/function/class`) the oracle cannot provide";
		}

		if (ts.isVariableStatement(statement) && (statement.declarationList.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
			for (const decl of statement.declarationList.declarations) {
				if (ts.isIdentifier(decl.name) && GLOBAL_NAMES.has(decl.name.text)) {
					return `re-declares the global \`${decl.name.text}\` with \`var\` (script semantics; tsval's program scope is a module)`;
				}
			}
		}
	}

	// (an explicit work list: a stress case nests expressions thousands of levels deep)
	const pending: ts.Node[] = [sf];

	while (pending.length > 0 && reason === undefined) {
		const node = pending.pop()!;

		if (ts.isDecorator(node)) {
			reason = "decorators (out of scope by policy)";
		} else if (ts.isVariableDeclarationList(node) && (node.flags & ts.NodeFlags.Using) !== 0) {
			reason = "`using` declarations (explicit resource management, not modeled)";
		} else if (ts.isPropertyDeclaration(node) && (ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Accessor) !== 0) {
			reason = "auto-accessor fields (decorators-adjacent, out of scope)";
		} else if (ts.isModuleDeclaration(node) && !(ts.getCombinedModifierFlags(node) & ts.ModifierFlags.Ambient)) {
			reason = "namespace / module blocks (runtime emit, out of scope)";
		} else if (ts.isImportEqualsDeclaration(node) || ts.isExportAssignment(node)) {
			reason = "module code (out of scope: tsval runs a program)";
		} else if (ts.isParameter(node) && ts.isConstructorDeclaration(node.parent) && ts.isParameterPropertyDeclaration(node, node.parent)) {
			reason = "parameter properties (non-erasable, out of scope)";
		} else {
			ts.forEachChild(node, (child) => {
				pending.push(child);
			});
		}
	}

	return reason;
}

/** The program text of an eligible single-file case. */
export function caseSource(test: TsCase): string {
	return test.files[0].text;
}
