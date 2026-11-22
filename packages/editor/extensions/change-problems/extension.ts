import { observeExtension } from "@brianjenkins94/editor-api/runtime";
import * as vscode from "vscode";

const LANGUAGES = new Set(["typescript", "typescriptreact", "javascript", "javascriptreact"]);
const SETTLE_MS = 500;

export function activate(context: vscode.ExtensionContext): void {
	const observed = observeExtension("change-problems", vscode);
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
