/**
 * cspell language server — a NODE server run under almostnode. It spell-checks documents with the REAL cspell
 * engine (cspell-lib), which is a node-only tool: it reads its dictionary (a gzipped trie) off "disk" and
 * gunzips it. Under almostnode that disk is the VFS and the gunzip is almostnode's zlib shim, so cspell runs
 * unmodified in the browser — which is the whole point of the almostnode host: node-only language tooling with
 * no node backend. It speaks LSP over the worker's message channel (`vscode-languageserver/browser`), so to
 * the client it's an ordinary worker server.
 *
 * cspell-lib and the LSP library are bundled in (bundledNodeServer in build.ts). The dictionary is too big to bundle, so
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
import { DICTIONARIES, servedName } from "./dictionaries";


// cspell's dictionaries for code (dictionaries.ts), each read from where server-host wrote it in the VFS: the ones for
// every language always, the rest for theirs. We deliberately skip getDefaultSettings() (it eagerly references all ~59
// bundled dicts) and config search: these alone.
const settings = {
	"version": "0.2" as const,
	"language": "en",
	"dictionaryDefinitions": DICTIONARIES.map((dictionary) => ({ "name": dictionary.name, "path": "/dicts/" + servedName(dictionary) })),
	"dictionaries": DICTIONARIES.filter((dictionary) => dictionary.languages === undefined).map((dictionary) => dictionary.name),
	"languageSettings": DICTIONARIES.filter((dictionary) => dictionary.languages !== undefined).map((dictionary) => ({ "languageId": (dictionary.languages ?? []).join(","), "dictionaries": [dictionary.name] }))
};

// Each open document's language, from its open: a change doesn't say it, and its dictionaries depend on it.
const languages = new Map<string, string>();

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
	languages.set(params.textDocument.uri, params.textDocument.languageId);
	check(params.textDocument.uri, params.textDocument.languageId, params.textDocument.text).catch(() => undefined);
});
connection.onDidChangeTextDocument((params) => {
	const last = params.contentChanges.at(-1);
	const text = last !== undefined && "text" in last ? last.text : "";

	// (languageId isn't sent on change: the one it opened with)
	check(params.textDocument.uri, languages.get(params.textDocument.uri) ?? "plaintext", text).catch(() => undefined);
});
connection.onDidCloseTextDocument((params) => {
	languages.delete(params.textDocument.uri);
	connection.sendDiagnostics({ "uri": params.textDocument.uri, "diagnostics": [] }).catch(() => undefined);
});

connection.listen();
