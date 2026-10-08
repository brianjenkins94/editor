// The renderer: a custom editor for a code file — "Reopen Editor With…" switches a file to it. The file's text stays
// the truth: render from it, and make every change a WorkspaceEdit, so the editor's history, annotations and live runs
// follow the edit as they would one typed in the text editor.
import * as vscode from "vscode";

export class Renderer implements vscode.CustomTextEditorProvider {
	resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
		panel.webview.options = { "enableScripts": true };

		const render = (): void => {
			// TODO: parse `document.getText()` and render it. Stub: the text, escaped.
			const escaped = document.getText().replace(/[&<>]/gu, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[character]);

			panel.webview.html = `<!doctype html><meta charset="utf-8"><pre>${escaped}</pre>`;
		};

		const changes = vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.document === document) {
				render();
			}
		});

		panel.onDidDispose(() => { changes.dispose(); });
		// TODO: turn the webview's messages into WorkspaceEdits on `document`.
		panel.webview.onDidReceiveMessage(() => undefined);
		render();
	}
}
