/**
 * What runs say could go, on the code (suggestions.ts finds it): each suggestion drawn in purple, the evidence's color —
 * an operator underlined, code that never ran tinted, more strongly the more tries say so — with a Hint diagnostic under
 * it, so the lightbulb offers its fix (never applied for you). Where the code is open, not in a view of its own: a list
 * somewhere else is somewhere nobody looks.
 */
import type { EvidenceStore } from "@brianjenkins94/editor-api/evidence";
import type { Suggestion } from "./suggestions";
import * as vscode from "vscode";
import { suggestions } from "./suggestions";

const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;

/** The languages whose code runs leave evidence in. */
const CODE_SELECTOR = [
	"typescript",
	"typescriptreact",
	"javascript",
	"javascriptreact"
].map((language) => ({ "language": language }));

/** The evidence's purple, by theme, at each strength (suggestions.ts `strength`). */
const PURPLE = { "dark": "#b180d7", "light": "#8250df" };
const ALPHA = ["99", "cc", "ff"];
const TINT = ["1f", "33", "4d"];

/** A decoration per style and strength: an underline (wavy) or a tint, and a mark in the overview ruler. */
function decorations(): Record<Suggestion["style"], vscode.TextEditorDecorationType[]> {
	const make = (style: Suggestion["style"], level: number): vscode.TextEditorDecorationType => {
		const themed = (color: string): vscode.ThemableDecorationRenderOptions => (style === "underline"
			? { "textDecoration": `underline wavy ${color}${ALPHA[level]}` }
			: { "backgroundColor": color + TINT[level] });

		return vscode.window.createTextEditorDecorationType({
			"dark": themed(PURPLE.dark),
			"light": themed(PURPLE.light),
			"overviewRulerColor": PURPLE.dark + ALPHA[level],
			"overviewRulerLane": vscode.OverviewRulerLane.Center
		});
	};

	return {
		"underline": [0, 1, 2].map((level) => make("underline", level)),
		"tint": [0, 1, 2].map((level) => make("tint", level))
	};
}

export function registerFixes(context: vscode.ExtensionContext, store: EvidenceStore): void {
	const diagnostics = vscode.languages.createDiagnosticCollection("evidence");
	const styles = decorations();
	/** Each diagnostic's fix, by the diagnostic. */
	const fixes = new WeakMap<vscode.Diagnostic, { "title": string; "range": vscode.Range; "text": string }>();
	/** Each open document's suggestions, and the text they're offsets into. */
	const byDocument = new Map<string, { "text": string; "suggestions": Suggestion[] }>();
	const thresholds = (): [number, number] => {
		const settings = vscode.workspace.getConfiguration("silo.evidence");

		return [settings.get<number>("minRuns") ?? 3, settings.get<number>("minSeen") ?? 10];
	};

	const draw = (editor: vscode.TextEditor): void => {
		const here = byDocument.get(editor.document.uri.toString());
		const current = here?.text === editor.document.getText()
			? here.suggestions
			: [];
		const range = (suggestion: Suggestion): vscode.Range => new vscode.Range(editor.document.positionAt(suggestion.start), editor.document.positionAt(suggestion.end));

		for (const style of ["underline", "tint"] as const) {
			for (const [level, decoration] of styles[style].entries()) {
				editor.setDecorations(decoration, current.filter((suggestion) => suggestion.style === style && suggestion.strength === level).map(range));
			}
		}
	};

	/** An open document: its suggestions drawn, and as diagnostics for the lightbulb. */
	const check = async (document: vscode.TextDocument): Promise<void> => {
		if (!CODE.test(document.uri.path)) {
			return;
		}

		const placed = await store.placed(document);

		if (placed === undefined) {
			return; // edited since: a newer look follows
		}

		const text = document.getText();
		const here = suggestions(text, placed, ...thresholds());
		const range = (start: number, end: number): vscode.Range => new vscode.Range(document.positionAt(start), document.positionAt(end));

		byDocument.set(document.uri.toString(), { "text": text, "suggestions": here });
		diagnostics.set(document.uri, here.map((suggestion) => {
			const diagnostic = new vscode.Diagnostic(range(suggestion.start, suggestion.end), suggestion.message, vscode.DiagnosticSeverity.Hint);

			diagnostic.source = "evidence";
			diagnostic.code = suggestion.code;

			if (suggestion.fix !== undefined) {
				fixes.set(diagnostic, {
					"title": suggestion.fix.title,
					"range": range(suggestion.fix.start, suggestion.fix.end),
					"text": suggestion.fix.text
				});
			}

			return diagnostic;
		}));

		for (const editor of vscode.window.visibleTextEditors.filter((candidate) => candidate.document === document)) {
			draw(editor);
		}
	};

	const checkOpen = (): void => {
		for (const editor of vscode.window.visibleTextEditors) {
			void check(editor.document);
		}
	};

	let typing: ReturnType<typeof setTimeout> | undefined;

	context.subscriptions.push(
		diagnostics,
		...Object.values(styles).flat(),
		vscode.languages.registerCodeActionsProvider(CODE_SELECTOR, {
			"provideCodeActions": (document, _range, { "diagnostics": here }) => here.flatMap((diagnostic) => {
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
		}, {
			"providedCodeActionKinds": [vscode.CodeActionKind.QuickFix]
		}),
		// A file's evidence changed (a run ended): the editors showing it looked at again.
		store.onDidChange((file) => {
			for (const editor of vscode.window.visibleTextEditors.filter((candidate) => vscode.workspace.asRelativePath(candidate.document.uri, false) === file)) {
				void check(editor.document);
			}
		}),
		// Shown: drawn from what's known, then looked at as the document it is.
		vscode.window.onDidChangeVisibleTextEditors((editors) => {
			for (const editor of editors) {
				draw(editor);
				void check(editor.document);
			}
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("silo.evidence")) {
				checkOpen();
			}
		}),
		// Edited: the marks no longer match until the evidence is placed again, once typing pauses (BABLR re-reads the
		// whole file), and the evidence follows the spans.
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.contentChanges.length > 0) {
				for (const editor of vscode.window.visibleTextEditors.filter((candidate) => candidate.document === event.document)) {
					draw(editor);
				}

				clearTimeout(typing);
				typing = setTimeout(() => {
					void check(event.document);
				}, 400);
			}
		}),
		// Closed: its marks and diagnostics go with it.
		vscode.workspace.onDidCloseTextDocument((document) => {
			diagnostics.delete(document.uri);
			byDocument.delete(document.uri.toString());
		})
	);
	checkOpen();
}
