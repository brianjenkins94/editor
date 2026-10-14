/**
 * cspell — spell-checks code and prose with the real cspell engine, a Node program, run in a worker of this extension's
 * own under almostnode (server-host.ts runs server-node.ts there) and connected to the editor as an ordinary language
 * server with a vscode-languageclient. Public API only: the worker reads nothing of the workspace (documents come over
 * LSP; its dictionary is its own), so nothing the editor's core has is needed here.
 */
import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/browser";
import { failureText, watchWorker } from "../../shared/failures";

// The documents it checks. The react language ids matter: a .tsx file's languageId is `typescriptreact`, and a client
// only forwards documents its selector names.
const DOCUMENTS = ["typescript", "typescriptreact", "javascript", "javascriptreact", "plaintext", "markdown", "json"].map((language) => ({ "language": language }));

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
	// server.js is a classic bootstrap that imports the module worker (an extension's workers start classic).
	// (named, so the architecture view and the memory gauge call it cspell)
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
