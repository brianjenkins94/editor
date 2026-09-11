/**
 * Spine B language server — a NODE server run under almostnode as ESM. almostnode runs `.mjs` files
 * through `runFile` as real ES modules (verified: `import` works and bare builtins resolve to its shims),
 * so this uses ESM `import` and `require("fs")` becomes `import … from "fs"` → almostnode's fs shim. That's
 * the whole point: a node-only server (cspell/eslint next) working in-browser. It speaks LSP over the
 * worker's message channel (`vscode-languageserver/browser`), so to the client it's an ordinary worker server.
 *
 * Bundled to ESM with node builtins left EXTERNAL (so `import "fs"` survives for almostnode to resolve) and
 * the LSP library inlined, then written to the VFS and run by almostnode inside server-host.ts. almostnode
 * detects ESM by content, so the bundle's `import`/`export` statements are what make it run as a module.
 */
// eslint-disable-next-line ts/no-restricted-imports, unicorn/prefer-node-protocol -- runs under almostnode (a node context); resolves to almostnode's fs shim, not the browser
import * as fs from "fs";
import {
	BrowserMessageReader,
	BrowserMessageWriter,
	createConnection,
	DiagnosticSeverity,
	TextDocumentSyncKind
} from "vscode-languageserver/browser";

// In the worker (shared globalThis) this is the DedicatedWorkerGlobalScope the client talks to.
const connection = createConnection(new BrowserMessageReader(globalThis as unknown as Worker), new BrowserMessageWriter(globalThis as unknown as Worker));

connection.onInitialize(() => ({ "capabilities": { "textDocumentSync": TextDocumentSyncKind.Full } }));

function publish(uri: string, text: string): void {
	// The proof: exercise a node capability (fs) through almostnode — write the doc to the VFS and read it
	// back — and report the round-trip in the diagnostic so success is visible in the editor.
	const roundTrip = ((): string => {
		try {
			fs.writeFileSync("/tmp/lsp-doc.txt", text);

			return `${fs.readFileSync("/tmp/lsp-doc.txt", "utf8").length}B`;
		} catch (error) {
			return "fs error: " + (error instanceof Error ? error.message : String(error));
		}
	})();

	connection.sendDiagnostics({
		"uri": uri,
		"diagnostics": [{
			"severity": DiagnosticSeverity.Information,
			"range": { "start": { "line": 0, "character": 0 }, "end": { "line": 0, "character": Math.min((text.split("\n")[0] ?? "").length, 8) } },
			"message": `LSP spine B ✓ — ESM node server on almostnode (fs round-trip: ${roundTrip}, platform: ${process.platform})`,
			"source": "lsp-spine-b"
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
