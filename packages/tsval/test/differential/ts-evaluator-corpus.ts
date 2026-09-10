/**
 * The ts-evaluator test corpus (vendor/ts-evaluator, MIT) as differential-oracle INPUT.
 *
 * ts-evaluator's own tests assert against its interpreter; we don't need its expectations — Node is
 * the oracle (ASSIGNMENT §5 S0). We extract the *program* from every `executeProgram(<code>, …)` call
 * in its test files and run each one through `classifyDifferential`. This is the executor-regression
 * oracle proving the recursive→stack rewrite preserved behavior, and it was written by someone else —
 * its blind spots are not correlated with ours.
 */
// eslint-disable-next-line ts/no-restricted-imports -- sync fs.readdirSync/readFileSync (a lazy generator walk) has no equivalent in the async-only util/fs wrapper
import fs from "node:fs";
import * as path from "node:path";
import ts from "typescript";

export interface CorpusProgram {
	/** `<file>#<n>` — stable id for the known-gaps list. */
	"id": string;
	/** the enclosing ts-evaluator `test("…")` name, for readable reports. */
	"name": string;
	"code": string;
}

const ROOT = path.resolve(import.meta.dirname, "../../vendor/ts-evaluator/test");

function *testFiles(dir: string): Generator<string> {
	for (const entry of fs.readdirSync(dir, { "withFileTypes": true })) {
		const full = path.join(dir, entry.name);

		if (entry.isDirectory()) {
			if (entry.name !== "setup") {
				yield* testFiles(full);
			}
		} else if (entry.name.endsWith(".test.ts")) {
			yield full;
		}
	}
}

function enclosingTestName(node: ts.Node): string {
	for (let current: ts.Node | undefined = node; current; current = current.parent) {
		if (ts.isCallExpression(current) && ts.isIdentifier(current.expression) && current.expression.text === "test") {
			const [first] = current.arguments;

			if (first && (ts.isStringLiteral(first) || ts.isNoSubstitutionTemplateLiteral(first))) {
				return first.text;
			}
		}
	}

	return "(unnamed)";
}

export function loadCorpus(): CorpusProgram[] {
	const out: CorpusProgram[] = [];

	for (const file of testFiles(ROOT)) {
		const rel = path.relative(ROOT, file);
		const sf = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
		let index = 0;
		const visit = (node: ts.Node): void => {
			if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "executeProgram") {
				const [arg] = node.arguments;

				// Only literal programs; a template with substitutions is test-harness plumbing, not a program.
				if (arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) {
					out.push({ "id": `${rel}#${index}`, "name": enclosingTestName(node), "code": arg.text });
				}

				index += 1;
			}

			ts.forEachChild(node, visit);
		};

		visit(sf);
	}

	return out;
}
