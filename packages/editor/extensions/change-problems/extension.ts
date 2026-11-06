/**
 * A change's problems' extension: what carries its TypeScript server plugin (ts-plugin.js, `typescriptServerPlugins` in its
 * manifest), which the TypeScript extension loads into its server. Core asks the plugin (workbench/code-problems.ts, through
 * `typescript.tsserverRequest`).
 *
 * And it keeps what's in an editor checked while code is opened behind it, which a change's problems does, as ESLint does. The
 * server gives up a pass over the open files when the open files change, and the TypeScript extension asks again only for a file
 * with a tab, or when a document closes: so a file opened in the background, at the wrong moment, left the one you're looking at
 * with no problems at all until it was edited or that document closed. So this asks again, once they've stopped being opened.
 */
import { observeExtension } from "@brianjenkins94/editor-api/runtime";
import * as vscode from "vscode";

const LANGUAGES = new Set(["typescript", "typescriptreact", "javascript", "javascriptreact"]);
/** How long after a document opens it's asked: documents come in bursts. */
const SETTLE_MS = 500;

export function activate(context: vscode.ExtensionContext): void {
	const observed = observeExtension("change-problems");
	let timer: ReturnType<typeof setTimeout> | undefined;

	const recheck = async (): Promise<void> => {
		const files = vscode.window.visibleTextEditors.map(({ document }) => document).filter((document) => document.uri.scheme === "file" && LANGUAGES.has(document.languageId));
		const [first] = files;

		if (first === undefined) {
			return;
		}

		const ask = async (): Promise<unknown> => vscode.commands.executeCommand("typescript.tsserverRequest", "_changeProblems.recheck", { "file": first.uri, "paths": files.map(({ uri }) => uri.path) });

		await (observed === undefined ? ask() : observed.log.span("editor.extensions.change-problems.recheck", { "count": files.length }, ask));
	};

	if (observed !== undefined) {
		context.subscriptions.push(observed);
	}

	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument((document) => {
			const inSight = vscode.window.visibleTextEditors.some((editor) => editor.document === document);

			if (LANGUAGES.has(document.languageId) && !inSight) {
				clearTimeout(timer);
				timer = setTimeout(() => {
					void Promise.resolve(recheck()).catch(() => undefined);
				}, SETTLE_MS);
			}
		}),
		{ "dispose": () => {
			clearTimeout(timer);
		} }
	);
}
