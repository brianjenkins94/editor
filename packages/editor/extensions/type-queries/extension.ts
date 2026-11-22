import { observeExtension } from "@brianjenkins94/editor-api/runtime";
import * as vscode from "vscode";

const LANGUAGES = [
	"typescript",
	"typescriptreact",
	"javascript",
	"javascriptreact"
];
const QUERY = /^\s*\/\/\s*\^\?/u;
const QUICK_INFO = /```(?:typescript|ts|tsx|javascript|js|jsx)\n([\s\S]*?)\n```/u;
const MAX_LABEL = 120;

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
	const hint = new vscode.InlayHint(new vscode.Position(line, column + 2), flat.length > MAX_LABEL
		? flat.slice(0, MAX_LABEL - 1) + "…"
		: flat);

	hint.paddingLeft = true;
	hint.tooltip = new vscode.MarkdownString().appendCodeblock(info, document.languageId);

	return hint;
}

export function activate(context: vscode.ExtensionContext): void {
	const observed = observeExtension("type-queries", vscode);
	const changed = new vscode.EventEmitter<void>();

	if (observed !== undefined) {
		context.subscriptions.push(observed);
	}

	context.subscriptions.push(
		changed,
		vscode.languages.onDidChangeDiagnostics(() => { changed.fire(); }),
		vscode.languages.registerInlayHintsProvider(LANGUAGES, {
			"onDidChangeInlayHints": changed.event,
			"provideInlayHints": async (document, range, token) => {
				const queries: number[] = [];

				for (let { line } = range.start; line <= range.end.line; line += 1) {
					if (QUERY.test(document.lineAt(line).text)) {
						queries.push(line);
					}
				}

				if (queries.length === 0) {
					return [];
				}

				const work = async (): Promise<vscode.InlayHint[]> => {
					const hints: vscode.InlayHint[] = [];

					for (const line of queries) {
						if (token.isCancellationRequested) {
							break;
						}

						const hint = await answer(document, line);

						if (hint !== undefined) {
							hints.push(hint);
						}
					}

					return hints;
				};

				return observed === undefined
					? work()
					: observed.log.span("editor.extensions.type-queries.answer", {
							"path": vscode.workspace.asRelativePath(document.uri, false),
							"count": queries.length
						}, work);
			}
		})
	);
}
