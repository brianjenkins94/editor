import { failureText, watchWorker } from "@brianjenkins94/editor-api/failures";
import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/browser";

const DOCUMENTS = ["typescript", "typescriptreact", "javascript", "javascriptreact", "plaintext", "markdown", "json"].map((language) => ({ "language": language, "scheme": "file" }));

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
	const worker = new Worker(vscode.Uri.joinPath(context.extensionUri, "server.js").toString(true), { "name": "cspell" });

	watchWorker(worker, "cspell");

	client = new LanguageClient("cspell", "cspell", worker, { "documentSelector": DOCUMENTS });
	client.start().catch((error: unknown) => {
		console.error("[cspell] language client failed to start:", failureText(error));
	});
}

export async function deactivate(): Promise<void> {
	await client?.stop();
}
