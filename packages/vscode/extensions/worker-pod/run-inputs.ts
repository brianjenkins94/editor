/**
 * Run with Inputs…: the file in the editor, run once per set of inputs, one after another, so its runtime evidence
 * (RUNTIME-EVIDENCE.md) is what it did across all of them — and what none of them ran shows, in purple, as code that
 * could go (insights' fixes.ts). Inputs read as a command line's: runs separated by `|`, a run's arguments by spaces,
 * quotes keeping a space in one; the program reads them as `process.argv`. Each runs under tsval without stopping at
 * breakpoints; the last inputs given for a file are offered again.
 */
import * as vscode from "vscode";
import { inputsKey, parseInputs } from "./inputs";

/** Run `program` once with `args`, under tsval, not stopping; settles when the run ends. */
async function runOnce(program: string, args: string[]): Promise<boolean> {
	const id = crypto.randomUUID();
	let listener: vscode.Disposable | undefined;
	const ended = new Promise<void>((resolve) => {
		listener = vscode.debug.onDidTerminateDebugSession((session) => {
			if (session.configuration["__runWithInputs"] === id) {
				resolve();
			}
		});
	});
	const name = program.split("/").pop()!;
	const started = await vscode.debug.startDebugging(undefined, { "type": "tsval", "request": "launch", "name": `${name} ${args.join(" ")}`.trim(), "program": program, "args": args, "noDebug": true, "__runWithInputs": id });

	if (started) {
		await ended;
	}

	listener?.dispose();

	return started;
}

export function registerRunWithInputs(context: vscode.ExtensionContext): void {
	context.subscriptions.push(vscode.commands.registerCommand("editor.runWithInputs", async (uri?: vscode.Uri) => {
		const file = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;

		if (file === undefined) {
			return;
		}

		const name = file.path.split("/").pop()!;
		const remembered = inputsKey(file.toString());
		const text = await vscode.window.showInputBox({
			"title": `Run ${name} with inputs`,
			"prompt": "Runs separated by |, each run's arguments by spaces (quote one with a space in it); the program reads them as process.argv",
			"placeHolder": "US | CA | FR --coupon \"SPRING 10\"",
			"value": context.workspaceState.get<string>(remembered) ?? ""
		});

		if (text === undefined) {
			return;
		}

		const runs = parseInputs(text);

		await context.workspaceState.update(remembered, text);
		await vscode.window.withProgress({ "location": vscode.ProgressLocation.Notification, "title": `Running ${name}`, "cancellable": true }, async (progress, token) => {
			for (const [index, args] of runs.entries()) {
				if (token.isCancellationRequested) {
					return;
				}

				progress.report({ "message": `${index + 1} of ${runs.length}: ${args.join(" ") || "no inputs"}`, "increment": 100 / runs.length });

				if (!await runOnce(file.path, args)) {
					void vscode.window.showErrorMessage(`Couldn't run ${name}.`);

					return;
				}
			}
		});
	}));
}
