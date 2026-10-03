/**
 * Type Queries — `// ^?` beneath an expression shows its type, as in the TypeScript Playground and twoslash:
 *
 *     const message = greet("world")
 *     //    ^? const message: string
 *
 * The caret points at a column of the line above (past any other query lines stacked there); what hovering that
 * character would say — TypeScript's quick info, the code block of its hover — is an inlay hint after the `^?`. Public
 * API only (an inlay-hints provider asking the hover providers), so it works the same in a desktop VS Code.
 *
 * A query's answer can change when another file does (the function it calls), and inlay hints are only re-asked for
 * on an edit to their own document; diagnostics changing is the sign TypeScript has re-checked, so that re-asks too.
 */
import * as vscode from "vscode";

const LANGUAGES = ["typescript", "typescriptreact", "javascript", "javascriptreact"];
const QUERY = /^\s*\/\/\s*\^\?/u;
// TypeScript's hover leads with its quick info as a fenced code block.
const QUICK_INFO = /```(?:typescript|ts|tsx|javascript|js|jsx)\n([\s\S]*?)\n```/u;
// One line in the editor; the full answer is the hint's tooltip.
const MAX_LABEL = 120;

/** The quick info a hover gives for `position`, or undefined when it has none. */
async function quickInfo(uri: vscode.Uri, position: vscode.Position): Promise<string | undefined> {
	const hovers = await vscode.commands.executeCommand<vscode.Hover[]>("vscode.executeHoverProvider", uri, position);

	for (const hover of hovers ?? []) {
		for (const content of hover.contents.filter((item): item is vscode.MarkdownString => item instanceof vscode.MarkdownString)) {
			const match = QUICK_INFO.exec(content.value);

			if (match !== null) {
				return match[1];
			}
		}
	}

	return undefined;
}

/** The hint answering the query on `line`, or undefined when the line isn't one or nothing answers it. */
async function answer(document: vscode.TextDocument, line: number): Promise<vscode.InlayHint | undefined> {
	const { text } = document.lineAt(line);

	if (!QUERY.test(text)) {
		return undefined;
	}

	const column = text.indexOf("^?");
	let target = line - 1;

	while (target >= 0 && QUERY.test(document.lineAt(target).text)) {
		target -= 1;
	}

	if (target < 0 || column >= document.lineAt(target).text.length) {
		return undefined;
	}

	const info = await quickInfo(document.uri, new vscode.Position(target, column));

	if (info === undefined) {
		return undefined;
	}

	const flat = info.replace(/\s+/gu, " ").trim();
	const hint = new vscode.InlayHint(new vscode.Position(line, column + 2), flat.length > MAX_LABEL ? flat.slice(0, MAX_LABEL - 1) + "…" : flat);

	hint.paddingLeft = true;
	hint.tooltip = new vscode.MarkdownString().appendCodeblock(info, document.languageId);

	return hint;
}

export function activate(context: vscode.ExtensionContext): void {
	const changed = new vscode.EventEmitter<void>();

	context.subscriptions.push(
		changed,
		vscode.languages.onDidChangeDiagnostics(() => { changed.fire(); }),
		vscode.languages.registerInlayHintsProvider(LANGUAGES, {
			"onDidChangeInlayHints": changed.event,
			"provideInlayHints": async (document, range, token) => {
				const hints: vscode.InlayHint[] = [];

				for (let line = range.start.line; line <= range.end.line && !token.isCancellationRequested; line += 1) {
					const hint = await answer(document, line);

					if (hint !== undefined) {
						hints.push(hint);
					}
				}

				return hints;
			}
		})
	);
}
