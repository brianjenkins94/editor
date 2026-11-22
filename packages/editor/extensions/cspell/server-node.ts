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


const settings = {
	"version": "0.2" as const,
	"language": "en",
	"dictionaryDefinitions": DICTIONARIES.map((dictionary) => ({ "name": dictionary.name, "path": "/dicts/" + servedName(dictionary) })),
	"dictionaries": DICTIONARIES.filter((dictionary) => dictionary.languages === undefined).map((dictionary) => dictionary.name),
	"languageSettings": DICTIONARIES.filter((dictionary) => dictionary.languages !== undefined).map((dictionary) => ({ "languageId": (dictionary.languages ?? []).join(","), "dictionaries": [dictionary.name] }))
};

const languages = new Map<string, string>();

const connection = createConnection(new BrowserMessageReader(globalThis as unknown as Worker), new BrowserMessageWriter(globalThis as unknown as Worker));

async function check(uri: string, languageId: string, text: string): Promise<void> {
	const document = createTextDocument({ "uri": uri, "content": text, "languageId": languageId });
	const result = await spellCheckDocument(document, { "noConfigSearch": true, "generateSuggestions": false }, settings);
	const textDocument = TextDocument.create(uri, languageId, 0, text);

	connection.sendDiagnostics({
		"uri": uri,
		"diagnostics": result.issues.map((issue) => {
			const start = textDocument.positionAt(issue.offset);
			const end = textDocument.positionAt(issue.offset + issue.text.length);

			return {
				"severity": DiagnosticSeverity.Hint,
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

	check(params.textDocument.uri, languages.get(params.textDocument.uri) ?? "plaintext", text).catch(() => undefined);
});
connection.onDidCloseTextDocument((params) => {
	languages.delete(params.textDocument.uri);
	connection.sendDiagnostics({ "uri": params.textDocument.uri, "diagnostics": [] }).catch(() => undefined);
});

connection.listen();
