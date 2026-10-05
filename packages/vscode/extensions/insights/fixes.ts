/**
 * What runs say could go, in the editor (suggestions.ts finds it): each suggestion drawn in purple — the evidence's
 * color — an operator underlined, code that never ran tinted, more strongly the more tries say so; a Hint diagnostic
 * under it, so the lightbulb offers its fix (never applied for you). And every file's, open or not, for the
 * Suggestions view (suggestions-view.ts): VS Code's Problems view doesn't list hints.
 */
import type { EvidenceStore } from "./evidence";
import type { Suggestion } from "./suggestions";
import { suggestions } from "./suggestions";
import * as vscode from "vscode";

const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;

/** The evidence's purple, by theme, at each strength (suggestions.ts `strength`). */
const PURPLE = { "dark": "#b180d7", "light": "#8250df" };
const ALPHA = ["99", "cc", "ff"];
const TINT = ["1f", "33", "4d"];

/** A file's suggestions, and the text they're offsets into. */
export interface FileSuggestions { "uri": vscode.Uri; "text": string; "suggestions": Suggestion[] }

/** Every file's suggestions, as they change. */
export interface SuggestionSource {
	"all": () => ReadonlyMap<string, FileSuggestions>;
	"onDidChange": vscode.Event<void>;
}

/** A decoration per style and strength: an underline (wavy) or a tint, and a mark in the overview ruler. */
function decorations(): Record<Suggestion["style"], vscode.TextEditorDecorationType[]> {
	const make = (style: Suggestion["style"], level: number): vscode.TextEditorDecorationType => {
		const themed = (color: string): vscode.ThemableDecorationRenderOptions => (style === "underline" ? { "textDecoration": `underline wavy ${color}${ALPHA[level]}` } : { "backgroundColor": color + TINT[level] });

		return vscode.window.createTextEditorDecorationType({ "dark": themed(PURPLE.dark), "light": themed(PURPLE.light), "overviewRulerColor": PURPLE.dark + ALPHA[level], "overviewRulerLane": vscode.OverviewRulerLane.Center });
	};

	return { "underline": [0, 1, 2].map((level) => make("underline", level)), "tint": [0, 1, 2].map((level) => make("tint", level)) };
}

export function registerFixes(context: vscode.ExtensionContext, store: EvidenceStore): SuggestionSource {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file("/workspace");
	const diagnostics = vscode.languages.createDiagnosticCollection("evidence");
	const styles = decorations();
	const changed = new vscode.EventEmitter<void>();
	/** Each diagnostic's fix, by the diagnostic. */
	const fixes = new WeakMap<vscode.Diagnostic, { "title": string; "range": vscode.Range; "text": string }>();
	/** Every file's suggestions, by workspace-relative path. */
	const byFile = new Map<string, FileSuggestions>();
	const thresholds = (): [number, number] => {
		const settings = vscode.workspace.getConfiguration("silo.evidence");

		return [settings.get<number>("minRuns") ?? 3, settings.get<number>("minSeen") ?? 10];
	};
	const update = (file: string, found: FileSuggestions | undefined): void => {
		if (found === undefined || found.suggestions.length === 0) {
			byFile.delete(file);
		} else {
			byFile.set(file, found);
		}

		changed.fire();
	};

	const draw = (editor: vscode.TextEditor): void => {
		const here = byFile.get(vscode.workspace.asRelativePath(editor.document.uri, false));
		const current = here?.text === editor.document.getText() ? here.suggestions : [];
		const range = (suggestion: Suggestion): vscode.Range => new vscode.Range(editor.document.positionAt(suggestion.start), editor.document.positionAt(suggestion.end));

		for (const style of ["underline", "tint"] as const) {
			for (const [level, decoration] of styles[style].entries()) {
				editor.setDecorations(decoration, current.filter((suggestion) => suggestion.style === style && suggestion.strength === level).map(range));
			}
		}
	};

	/** An open document: its suggestions drawn, and as diagnostics for the lightbulb. */
	const check = async (document: vscode.TextDocument): Promise<void> => {
		if (document.uri.scheme !== "file" || !CODE.test(document.uri.path)) {
			return;
		}

		const placed = await store.placed(document);

		if (placed === undefined) {
			return; // edited since: a newer look follows
		}

		const text = document.getText();
		const here = suggestions(text, placed, ...thresholds());
		const range = (start: number, end: number): vscode.Range => new vscode.Range(document.positionAt(start), document.positionAt(end));

		update(vscode.workspace.asRelativePath(document.uri, false), { "uri": document.uri, "text": text, "suggestions": here });
		diagnostics.set(document.uri, here.map((suggestion) => {
			const diagnostic = new vscode.Diagnostic(range(suggestion.start, suggestion.end), suggestion.message, vscode.DiagnosticSeverity.Hint);

			diagnostic.source = "evidence";
			diagnostic.code = suggestion.code;

			if (suggestion.fix !== undefined) {
				fixes.set(diagnostic, { "title": suggestion.fix.title, "range": range(suggestion.fix.start, suggestion.fix.end), "text": suggestion.fix.text });
			}

			return diagnostic;
		}));

		for (const editor of vscode.window.visibleTextEditors.filter((candidate) => candidate.document === document)) {
			draw(editor);
		}
	};

	/** A file with evidence: the open document's suggestions, or — open nowhere — its text on disk's. */
	const checkFile = async (file: string): Promise<void> => {
		const uri = vscode.Uri.joinPath(root, file);
		const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());

		if (open !== undefined) {
			return check(open);
		}

		const text = await Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => undefined);

		update(file, text === undefined ? undefined : { "uri": uri, "text": text, "suggestions": suggestions(text, await store.placedIn(file, text), ...thresholds()) });
	};

	const checkAll = async (): Promise<void> => {
		const files = await store.files();

		for (const file of [...byFile.keys()].filter((known) => !files.includes(known))) {
			update(file, undefined);
		}

		for (const file of files.filter((candidate) => CODE.test(candidate))) {
			await checkFile(file);
		}
	};
	let typing: ReturnType<typeof setTimeout> | undefined;

	context.subscriptions.push(diagnostics, changed, ...Object.values(styles).flat(),
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
		store.onDidChange((file) => { void checkFile(file); }),
		// Shown: drawn from what's known, then looked at as the document it is (its diagnostics, for the lightbulb).
		vscode.window.onDidChangeVisibleTextEditors((editors) => {
			for (const editor of editors) {
				draw(editor);
				void check(editor.document);
			}
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("silo.evidence")) {
				void checkAll();
			}
		}),
		// Edited: the marks no longer match until the evidence is placed again, once typing pauses (BABLR re-reads the
		// whole file) — and the evidence follows the spans.
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.contentChanges.length > 0) {
				for (const editor of vscode.window.visibleTextEditors.filter((candidate) => candidate.document === event.document)) {
					draw(editor);
				}

				clearTimeout(typing);
				typing = setTimeout(() => { void check(event.document); }, 400);
			}
		}),
		// Closed: back to its text on disk (its diagnostics go with the editor).
		vscode.workspace.onDidCloseTextDocument((document) => {
			if (document.uri.scheme === "file" && CODE.test(document.uri.path)) {
				diagnostics.delete(document.uri);
				void checkFile(vscode.workspace.asRelativePath(document.uri, false));
			}
		})
	);
	void checkAll();

	return { "all": () => byFile, "onDidChange": changed.event };
}
