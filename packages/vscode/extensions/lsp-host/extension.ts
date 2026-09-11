/**
 * LSP Host — the manager extension (runs in the extension host, LocalProcess). It runs language servers
 * off-thread in workers and connects each to the editor with a vscode-languageclient. The client
 * integration (diagnostics/hover/completion) is the language client's job; the server runs in the worker.
 *
 * The worker (server-host) runs a NODE language server under an almostnode runtime, so a server using
 * `require("fs")` works in-browser. It's built + served separately (lsp.config.ts → /__vscode__/lsp/,
 * with COEP) as a normal module graph — not a blob — because almostnode can't be monolithically inlined.
 * The extension can't emit/locate that asset from its data:-URL self, so it spawns it by URL relative to
 * the workbench origin (`location.href`), the same way the preflight engine URL is resolved.
 */
import type * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/browser";

let client: LanguageClient | undefined;

export function activate(context: vscode.ExtensionContext): void {
	// The workbench iframe's origin; the LocalProcess ext host shares it. server-host.js is served next to
	// host.html under /__vscode__/lsp/ (lsp.config.ts).
	const serverUrl = new URL("./lsp/server-host.js", location.href);
	const worker = new Worker(serverUrl, { "type": "module" });

	worker.addEventListener("error", (event) => {
		console.error("[lsp-host] server worker error:", event.message, "@", event.filename + ":" + event.lineno);
	});

	client = new LanguageClient(
		"lsp-spine",
		"LSP Spine (almostnode)",
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
