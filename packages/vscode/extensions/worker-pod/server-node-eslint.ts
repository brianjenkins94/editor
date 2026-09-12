/**
 * eslint language server — a NODE server run under almostnode. It lints JS/TS with the REAL eslint engine
 * plus @typescript-eslint/parser (so it can parse the workspace's TypeScript), which is the whole point of
 * the almostnode host: node-only language tooling in-browser with no node backend. It speaks LSP over the
 * worker's message channel (`vscode-languageserver/browser`), so to the client it's an ordinary worker server.
 *
 * This first version lints with a fixed flat config passed inline to eslint's `Linter` (no config-file
 * loading, so no filesystem needed beyond almostnode's env). Loading the workspace's own eslint.config.js is
 * the next step — the machinery is already in place (almostnode's VFS is zen-fs, and the file:// import patch
 * lets eslint's flat-config loader import a config from it); it just needs the workspace files bridged into
 * zen-fs. eslint-lib and the TS parser are bundled in (see entry.config.ts).
 */
import * as tsParserModule from "@typescript-eslint/parser";
import { Linter } from "eslint";
import {
	BrowserMessageReader,
	BrowserMessageWriter,
	createConnection,
	DiagnosticSeverity,
	TextDocumentSyncKind
} from "vscode-languageserver/browser";

const linter = new Linter();

// The parser object eslint needs (has parseForESLint/parse). Bundlers differ on CJS/ESM default interop —
// @typescript-eslint/parser may land on the module namespace or its `.default` — so pick whichever actually
// carries the parse functions.
function resolveParser(module: Record<string, unknown>): Linter.Parser {
	for (const candidate of [module.default, module] as Record<string, unknown>[]) {
		if (candidate !== undefined && (typeof candidate.parseForESLint === "function" || typeof candidate.parse === "function")) {
			return candidate as unknown as Linter.Parser;
		}
	}

	throw new Error("[server-node-eslint] @typescript-eslint/parser has no parse/parseForESLint export");
}

const tsParser = resolveParser(tsParserModule as unknown as Record<string, unknown>);

// A small, universally-applicable flat config. `files` must match (relative to the cwd basePath) or eslint
// reports "No matching configuration found" instead of linting. @typescript-eslint/parser (no `project`
// option → syntactic parsing, no type info, no fs) lets these rules run on TypeScript as well as JavaScript.
const config = [{
	"files": ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
	"languageOptions": { "parser": tsParser },
	// A small set of rules that work on TS with only the parser (no type info): syntactic checks, no `no-undef`
	// (it can't see TS types/globals — typescript-eslint disables it for TS). A full ruleset is a follow-up.
	"rules": {
		"prefer-const": "error",
		"no-debugger": "error",
		"no-var": "error",
		"no-constant-condition": "warn",
		"no-empty": "warn"
	}
}] satisfies Linter.Config[];

// LSP document URIs are file:// URLs; eslint's flat-config file matching wants a filesystem path.
function uriToPath(uri: string): string {
	if (!uri.startsWith("file://")) {
		return uri;
	}

	let path = decodeURIComponent(uri.slice("file://".length));

	if (path.startsWith("/") && path[2] === ":") {
		path = path.slice(1);
	}

	return path;
}

// In the worker (shared globalThis) this is the DedicatedWorkerGlobalScope the client talks to.
const connection = createConnection(new BrowserMessageReader(globalThis as unknown as Worker), new BrowserMessageWriter(globalThis as unknown as Worker));

// eslint positions are 1-based (line/column); LSP is 0-based. A message without an end falls back to a
// single-character range at its start.
function toRange(message: Linter.LintMessage): { "start": { "line": number; "character": number }; "end": { "line": number; "character": number } } {
	const startLine = Math.max(0, message.line - 1);
	const startChar = Math.max(0, message.column - 1);
	const endLine = message.endLine === undefined ? startLine : Math.max(0, message.endLine - 1);
	const endChar = message.endColumn === undefined ? startChar + 1 : Math.max(0, message.endColumn - 1);

	return { "start": { "line": startLine, "character": startChar }, "end": { "line": endLine, "character": endChar } };
}

function check(uri: string, text: string): void {
	// A lint failure on one document shouldn't take the server down; publish nothing and move on.
	let messages: Linter.LintMessage[];

	try {
		messages = linter.verify(text, config, { "filename": uriToPath(uri) });
	} catch (error) {
		console.error("[server-node-eslint] verify failed", error);

		return;
	}

	connection.sendDiagnostics({
		"uri": uri,
		"diagnostics": messages.map((message) => ({
			"severity": message.severity === 2 ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
			"range": toRange(message),
			"message": message.message,
			"source": "eslint",
			...message.ruleId === null ? {} : { "code": message.ruleId }
		}))
	}).catch(() => undefined);
}

connection.onInitialize(() => ({ "capabilities": { "textDocumentSync": TextDocumentSyncKind.Full } }));

connection.onDidOpenTextDocument((params) => {
	check(params.textDocument.uri, params.textDocument.text);
});
connection.onDidChangeTextDocument((params) => {
	const last = params.contentChanges.at(-1);

	check(params.textDocument.uri, last !== undefined && "text" in last ? last.text : "");
});
connection.onDidCloseTextDocument((params) => {
	connection.sendDiagnostics({ "uri": params.textDocument.uri, "diagnostics": [] }).catch(() => undefined);
});

connection.listen();
