/**
 * LSP Host — the manager extension (runs in the extension host). It supervises language servers that run
 * in workers and connects each to the editor with a vscode-languageclient. Everything the editor needs is
 * driven from inside the extension host: the client integration (diagnostics/hover/completion) is the
 * language client's job, and the server runs off-thread in a worker.
 *
 * Spine A (this): one trivial server, bundled into the extension and spawned as a Blob-URL module worker —
 * so the server ships INSIDE the extension, nothing is served separately. Spine B swaps that worker for an
 * almostnode runtime hosting a real node language server (cspell first).
 */
import type * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/browser";
// The trivial server, bundled to a string by entry.config.ts's bundledWorker plugin (deps inlined).
import serverCode from "lsp-host:server";

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
	// Ship the server inside the extension: turn its bundled source into a Blob and run it as a module
	// worker. A same-origin blob worker inherits the page's COEP, so it loads under cross-origin isolation.
	const workerUrl = URL.createObjectURL(new Blob([serverCode], { "type": "text/javascript" }));
	const worker = new Worker(workerUrl, { "type": "module" });

	client = new LanguageClient(
		"lsp-spine",
		"LSP Spine",
		worker,
		{ "documentSelector": [{ "language": "typescript" }, { "language": "plaintext" }] }
	);

	context.subscriptions.push({
		"dispose": () => {
			if (client !== undefined) {
				client.stop().catch(() => undefined);
			}
		}
	});

	client.start().then(() => {
		console.log("[lsp-host] language client started");
	}).catch((error: unknown) => {
		console.error("[lsp-host] client start failed", error);
	});
}

export function deactivate(): Thenable<void> | undefined {
	return client?.stop();
}
