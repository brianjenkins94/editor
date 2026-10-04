/**
 * What runs say could go (RUNTIME-EVIDENCE.md, the second slice; D8): a `?.` that never met a nullish value, a `??`
 * whose right side never ran, a branch one arm of which never ran — as hints, with the evidence in the message, and for
 * the first two a quick fix that removes them. Only on a strict claim: never once since the span last changed (its id
 * changes when its code does, so its counts start over), across at least `silo.evidence.minRuns` runs and
 * `silo.evidence.minSeen` values. A branch gets no fix: deleting code on evidence alone is for you to decide.
 */
import type { EvidenceStore, Placed } from "./evidence";
import * as vscode from "vscode";

const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;

/** The operators at the top level of `text` (outside brackets, strings and comments): each `?.` and `??`, by offset. */
export function topLevelOperators(text: string): { "optional": number[]; "nullish": number[] } {
	const optional: number[] = [];
	const nullish: number[] = [];
	let depth = 0;

	for (let index = 0; index < text.length; index += 1) {
		const char = text[index];
		const next = text[index + 1];

		if (char === "\"" || char === "'" || char === "`") {
			for (index += 1; index < text.length && text[index] !== char; index += 1) {
				if (text[index] === "\\") {
					index += 1;
				}
			}
		} else if (char === "/" && next === "/") {
			index = text.includes("\n", index) ? text.indexOf("\n", index) : text.length;
		} else if (char === "/" && next === "*") {
			index = text.includes("*/", index + 2) ? text.indexOf("*/", index + 2) + 1 : text.length;
		} else if (char === "(" || char === "[" || char === "{") {
			depth += 1;
		} else if (char === ")" || char === "]" || char === "}") {
			depth -= 1;
		} else if (depth === 0 && char === "?" && next === "?") {
			nullish.push(index);
			index += 1;
		} else if (depth === 0 && char === "?" && next === "." && !/\d/u.test(text[index + 2] ?? "")) {
			optional.push(index);
			index += 1;
		}
	}

	return { "optional": optional, "nullish": nullish };
}

/** A hint that something could go, and the edit that removes it (none for a branch). */
interface Finding { "range": vscode.Range; "message": string; "code": string; "fix"?: { "title": string; "range": vscode.Range; "text": string } }

const runs = (n: number): string => `${n.toLocaleString("en-US")} run${n === 1 ? "" : "s"}`;

/** What could go in `document`, by its evidence `placed` there, at the thresholds given. */
export function findings(document: vscode.TextDocument, placed: Placed[], minRuns: number, minSeen: number): Finding[] {
	const found: Finding[] = [];

	for (const { start, end, type, evidence } of placed) {
		const text = document.getText().slice(start, end);
		const { value, branch } = evidence;

		if (value !== undefined && value.nullish === 0 && value.ever >= minRuns && value.seen >= minSeen) {
			const operators = topLevelOperators(text);
			// The span's own operator is its last at the top level: the one after its base, before its property or
			// arguments (`a?.b?.()`), or between its sides (`a ?? b ?? c` is `(a ?? b) ?? c`).
			const at = type === "MemberExpression" || type === "CallExpression" ? operators.optional.at(-1) : type === "BinaryExpression" ? operators.nullish.at(-1) : undefined;
			const evidenceText = `${value.seen.toLocaleString("en-US")} values in ${runs(value.ever)} since this code last changed`;

			if (at !== undefined && (type === "MemberExpression" || type === "CallExpression")) {
				const token = new vscode.Range(document.positionAt(start + at), document.positionAt(start + at + 2));
				// `a?.b` → `a.b`; `a?.[k]` and `f?.()` → `a[k]`, `f()`.
				const replacement = /[[(]/u.test(text[at + 2] ?? "") ? "" : ".";

				found.push({ "range": token, "message": `\`?.\` never met a nullish value: ${evidenceText}.`, "code": "unneeded-optional-chain", "fix": { "title": `Remove the \`?.\` (never nullish in ${runs(value.ever)})`, "range": token, "text": replacement } });
			} else if (at !== undefined) {
				const right = new vscode.Range(document.positionAt(start + at), document.positionAt(end));

				found.push({ "range": right, "message": `The right side of \`??\` never ran — its left was never nullish: ${evidenceText}.`, "code": "unneeded-nullish-coalescing", "fix": { "title": `Remove \`${text.slice(at).replace(/\s+/gu, " ").slice(0, 30)}\` (its left never nullish in ${runs(value.ever)})`, "range": new vscode.Range(document.positionAt(start + text.slice(0, at).trimEnd().length), document.positionAt(end)), "text": "" } });
			}
		}

		if (branch !== undefined && branch.ever >= minRuns) {
			const total = branch.arms.reduce((sum, n) => sum + n, 0);
			const never = branch.arms.findIndex((n) => n === 0);

			if (never !== -1 && total >= minSeen) {
				const names = type === "If" ? ["then", "else"] : type === "TernaryExpression" ? ["true", "false"] : ["right side", "short-circuit"];
				const startAt = document.positionAt(start);
				const firstLine = new vscode.Range(startAt, document.lineAt(startAt.line).range.end.isBefore(document.positionAt(end)) ? document.lineAt(startAt.line).range.end : document.positionAt(end));

				found.push({ "range": firstLine, "message": `The ${type === "If" ? "`if`'s" : type === "TernaryExpression" ? "`?:`'s" : "`&&`/`||`'s"} ${names[never]} never ran: ${total.toLocaleString("en-US")} time${total === 1 ? "" : "s"} in ${runs(branch.ever)}, every one the ${names[1 - never]}.`, "code": "branch-never-taken" });
			}
		}
	}

	return found;
}

export function registerFixes(context: vscode.ExtensionContext, store: EvidenceStore): void {
	const diagnostics = vscode.languages.createDiagnosticCollection("evidence");
	/** Each diagnostic's fix, by the diagnostic. */
	const fixes = new WeakMap<vscode.Diagnostic, NonNullable<Finding["fix"]>>();

	const check = async (document: vscode.TextDocument): Promise<void> => {
		if (document.uri.scheme !== "file" || !CODE.test(document.uri.path)) {
			return;
		}

		const placed = await store.placed(document);

		if (placed === undefined) {
			return; // edited since: a newer look follows
		}

		const settings = vscode.workspace.getConfiguration("silo.evidence");
		const found = findings(document, placed, settings.get<number>("minRuns") ?? 3, settings.get<number>("minSeen") ?? 10);

		diagnostics.set(document.uri, found.map((finding) => {
			const diagnostic = new vscode.Diagnostic(finding.range, finding.message, vscode.DiagnosticSeverity.Hint);

			diagnostic.source = "evidence";
			diagnostic.code = finding.code;

			if (finding.fix !== undefined) {
				fixes.set(diagnostic, finding.fix);
			}

			return diagnostic;
		}));
	};

	const checkVisible = (): void => {
		for (const editor of vscode.window.visibleTextEditors) {
			void check(editor.document);
		}
	};
	let typing: ReturnType<typeof setTimeout> | undefined;

	context.subscriptions.push(diagnostics,
		vscode.languages.registerCodeActionsProvider({ "scheme": "file" }, {
			"provideCodeActions": (document, _range, { diagnostics: here }) => here.flatMap((diagnostic) => {
				const fix = fixes.get(diagnostic);

				if (fix === undefined) {
					return [];
				}

				const action = new vscode.CodeAction(fix.title, vscode.CodeActionKind.QuickFix);

				action.edit = new vscode.WorkspaceEdit();
				action.edit.replace(document.uri, fix.range, fix.text);
				action.diagnostics = [diagnostic];

				return [action];
			})
		}, { "providedCodeActionKinds": [vscode.CodeActionKind.QuickFix] }),
		store.onDidChange(checkVisible),
		vscode.window.onDidChangeVisibleTextEditors(checkVisible),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("silo.evidence")) {
				checkVisible();
			}
		}),
		// Edited: the evidence follows the spans; look again once typing pauses (BABLR re-reads the whole file).
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.contentChanges.length > 0) {
				clearTimeout(typing);
				typing = setTimeout(() => { void check(event.document); }, 400);
			}
		})
	);
	checkVisible();
}
