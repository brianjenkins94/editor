/**
 * Hello world extension — the smallest possible product extension for the workbench.
 *
 * Bundled to a browser CommonJS string by the `hello:extension` virtual module (entry.config.ts) and
 * registered from workbench-entry.tsx via a data: URL. `vscode` stays external: the host injects it.
 * Activates on startup, greets once, and contributes a `Hello: Hello World` command palette entry.
 */
import * as vscode from "vscode";

export function activate(context: vscode.ExtensionContext): void {
	context.subscriptions.push(vscode.commands.registerCommand("hello.helloWorld", () => {
		void vscode.window.showInformationMessage("Hello World from the editor extension!");
	}));

	void vscode.commands.executeCommand("hello.helloWorld");
}

export function deactivate(): void { /* the command is disposed via context.subscriptions */ }
