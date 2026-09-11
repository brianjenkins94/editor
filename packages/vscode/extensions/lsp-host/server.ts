/**
 * Trivial LSP server for the spine — proves a language server running in a WORKER can push a diagnostic
 * back into the editor through a vscode-languageclient. It speaks raw LSP over the worker message channel
 * (no TextDocuments model, no extra deps): on open/change of any doc it publishes one Information
 * diagnostic at the top of the file.
 *
 * Spine A runs this in a plain module worker. Spine B runs this SAME file inside an almostnode runtime
 * (the server never touches the vscode API — only LSP — which is exactly why almostnode can host it).
 */
import {
	BrowserMessageReader,
	BrowserMessageWriter,
	createConnection,
	DiagnosticSeverity,
	TextDocumentSyncKind
} from "vscode-languageserver/browser";

// In a module worker `globalThis` is the DedicatedWorkerGlobalScope — the message target LSP reads/writes.
const connection = createConnection(new BrowserMessageReader(globalThis as unknown as Worker), new BrowserMessageWriter(globalThis as unknown as Worker));

connection.onInitialize(() => ({ "capabilities": { "textDocumentSync": TextDocumentSyncKind.Full } }));

function publish(uri: string, text: string): void {
	const firstLine = text.split("\n")[0] ?? "";

	connection.sendDiagnostics({
		"uri": uri,
		"diagnostics": [{
			"severity": DiagnosticSeverity.Information,
			"range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": Math.min(firstLine.length, 8) } },
			"message": "LSP spine ✓ — diagnostic from the worker language server",
			"source": "lsp-spine"
		}]
	}).catch(() => undefined);
}

connection.onDidOpenTextDocument((params) => {
	publish(params.textDocument.uri, params.textDocument.text);
});
connection.onDidChangeTextDocument((params) => {
	const last = params.contentChanges.at(-1);

	publish(params.textDocument.uri, last !== undefined && "text" in last ? last.text : "");
});

connection.listen();
