/**
 * cspell language server — a NODE server run under almostnode. It spell-checks documents with the REAL cspell
 * engine (cspell-lib), which is a node-only tool: it reads its dictionary (a gzipped trie) off "disk" and
 * gunzips it. Under almostnode that disk is the VFS and the gunzip is almostnode's zlib shim, so cspell runs
 * unmodified in the browser — which is the whole point of the almostnode host: node-only language tooling with
 * no node backend. It speaks LSP over the worker's message channel (`vscode-languageserver/browser`), so to
 * the client it's an ordinary worker server.
 *
 * cspell-lib and the LSP library are bundled in (see entry.config.ts). The dictionary is too big to bundle, so
 * server-host fetches it and writes it to the VFS at DICT_PATH before this server runs.
 */
import {
	createTextDocument,
	spellCheckDocument
} from "cspell-lib";
import { TextDocument } from "vscode-languageserver-textdocument";
import {
	BrowserMessageReader,
	BrowserMessageWriter,
	createConnection,
	DiagnosticSeverity,
	TextDocumentSyncKind
} from "vscode-languageserver/browser";

// Where server-host writes the dictionary into the VFS. cspell reads it through almostnode's fs shim.
const DICT_PATH = "/dicts/en_US.trie.gz";

// Minimal cspell settings: just the one English dictionary, resolved from the VFS. We deliberately skip
// getDefaultSettings() (it eagerly references all ~59 bundled dicts); cspell fail-softs on the few default
// dictionaries it still probes and checks against en_US alone.
const settings = {
	"version": "0.2" as const,
	"language": "en",
	"dictionaryDefinitions": [{ "name": "en_US", "path": DICT_PATH }],
	"dictionaries": ["en_US"]
};

// In the worker (shared globalThis) this is the DedicatedWorkerGlobalScope the client talks to.
const connection = createConnection(new BrowserMessageReader(globalThis as unknown as Worker), new BrowserMessageWriter(globalThis as unknown as Worker));

async function check(uri: string, languageId: string, text: string): Promise<void> {
	const document = createTextDocument({ "uri": uri, "content": text, "languageId": languageId });
	const result = await spellCheckDocument(document, { "noConfigSearch": true, "generateSuggestions": false }, settings);
	// cspell reports issues by absolute character offset; the editor wants line/character ranges.
	// vscode-languageserver-textdocument's TextDocument.positionAt does exactly that conversion.
	const textDocument = TextDocument.create(uri, languageId, 0, text);

	connection.sendDiagnostics({
		"uri": uri,
		"diagnostics": result.issues.map((issue) => {
			const start = textDocument.positionAt(issue.offset);
			const end = textDocument.positionAt(issue.offset + issue.text.length);

			return {
				"severity": DiagnosticSeverity.Information,
				"range": { "start": start, "end": end },
				"message": `Unknown word: "${issue.text}"`,
				"source": "cspell"
			};
		})
	}).catch(() => undefined);
}

connection.onInitialize(() => ({ "capabilities": { "textDocumentSync": TextDocumentSyncKind.Full } }));

connection.onDidOpenTextDocument((params) => {
	check(params.textDocument.uri, params.textDocument.languageId, params.textDocument.text).catch(() => undefined);
});
connection.onDidChangeTextDocument((params) => {
	const last = params.contentChanges.at(-1);
	const text = last !== undefined && "text" in last ? last.text : "";

	// languageId isn't sent on change; cspell only needs it to pick language settings, and "plaintext" checks
	// prose in any file, which is the behavior we want for a spell-checker.
	check(params.textDocument.uri, "plaintext", text).catch(() => undefined);
});
connection.onDidCloseTextDocument((params) => {
	connection.sendDiagnostics({ "uri": params.textDocument.uri, "diagnostics": [] }).catch(() => undefined);
});

connection.listen();
