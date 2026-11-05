/**
 * Run (RUNNING.md, *The model*): the one action, on a file. The editor's play button and the palette's *Debug: Run* run the file
 * they're on, and F5 with no launch.json runs the one you're looking at, each as the same session.
 *
 * What it runs is a code file on disk, never what the active editor happens to be: with the Output view focused that's its channel,
 * which isn't a file a run could read.
 */
import { logger } from "@brianjenkins94/util/logger";
import * as vscode from "vscode";

const CODE = /\.[cm]?[jt]sx?$/u;
const log = logger({ "source": "run-file" });

const runnable = (uri: vscode.Uri | undefined): uri is vscode.Uri => uri?.scheme === "file" && CODE.test(uri.path);

/** The file to run: the one asked for; else the active editor's; else one in sight. */
export function fileToRun(asked?: unknown): vscode.Uri | undefined {
	return [asked instanceof vscode.Uri ? asked : undefined, vscode.window.activeTextEditor?.document.uri, ...vscode.window.visibleTextEditors.map((editor) => editor.document.uri)].find(runnable);
}

/** A run of `file`, as a launch configuration: what it's called is all a person sees of what runs it. */
export const runOf = (file: vscode.Uri): vscode.DebugConfiguration => ({ "type": "tsval", "request": "launch", "name": "Run", "program": file.path });

/** There's nothing to run: said, rather than a run that can't read its program. */
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
