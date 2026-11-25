import { runDebugger } from "@brianjenkins94/editor-api/debugger";
import { logger } from "@brianjenkins94/util/logger";
import * as vscode from "vscode";

const CODE = /\.[cm]?[jt]sx?$/u;
const log = logger({ "source": "run-file" });

const runnable = (uri: vscode.Uri | undefined): uri is vscode.Uri => uri?.scheme === "file" && CODE.test(uri.path);

export function fileToRun(asked?: unknown): vscode.Uri | undefined {
	return [asked instanceof vscode.Uri ? asked : undefined, vscode.window.activeTextEditor?.document.uri, ...vscode.window.visibleTextEditors.map((editor) => editor.document.uri)].find(runnable);
}

export const runOf = (file: vscode.Uri): vscode.DebugConfiguration => ({ "type": runDebugger(), "request": "launch", "name": "Run", "program": file.path });

export function nothingToRun(): void {
	void vscode.window.showInformationMessage("Open a JavaScript or TypeScript file to run it.");
}

export function registerRunFile(context: vscode.ExtensionContext): void {
	context.subscriptions.push(vscode.commands.registerCommand("editor.debugFile", async (asked: unknown) => {
		const file = fileToRun(asked);

		if (file === undefined) {
			nothingToRun();

			return;
		}

		await log.span("editor.extensions.tsval.run-file.run", { "path": file.path }, async () => vscode.debug.startDebugging(undefined, runOf(file)));
	}));
}
