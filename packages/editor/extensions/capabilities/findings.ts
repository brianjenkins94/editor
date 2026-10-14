/**
 * The capability findings, shown: each open TypeScript/JavaScript document's (the plugin's `_capabilities.findings` —
 * engine.findings over the tree the TypeScript server holds) as this extension's own diagnostics — source
 * "capabilities", code 900100; a dangerous capability a warning, the rest a hint — so they're squiggles, in Problems
 * (the warnings) and in the hover, and the Capability calls panel reads them back (extension.ts).
 *
 * Asked as a document opens and once its edits settle, and again while the canary is still running (`pending`) or the
 * server isn't up yet. The plugin only answers: nothing is put into the TypeScript server's own diagnostics, so whatever
 * hosts the readings later (TypeScript 7's API connection) answers the same request.
 */
import * as vscode from "vscode";

const LANGUAGES = new Set(["typescript", "typescriptreact", "javascript", "javascriptreact"]);
/** How long edits settle before a document is asked about. */
const SETTLE_MS = 300;
/** How long apart, and how often, a document is asked again while its answer isn't final. */
const AGAIN_MS = 1000;
const AGAIN = 30;

/** What `_capabilities.findings` answers. */
interface Answer {
	"ready"?: boolean;
	"pending"?: boolean;
	"findings"?: { "start": number; "end": number; "dangerous": boolean; "message": string }[];
}

export function publishFindings(context: vscode.ExtensionContext): void {
	const collection = vscode.languages.createDiagnosticCollection("capabilities");
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	const shown = (document: vscode.TextDocument): boolean => document.uri.scheme === "file" && LANGUAGES.has(document.languageId);

	const ask = async (document: vscode.TextDocument, again: number): Promise<void> => {
		const { version } = document;
		const response = await Promise.resolve(vscode.commands.executeCommand<{ "body"?: Answer } | undefined>("typescript.tsserverRequest", "_capabilities.findings", { "file": document.uri })).catch(() => undefined);
		const answer = response?.body;

		// (closed meanwhile, or edited: a later ask is on its way)
		if (document.isClosed || document.version !== version) {
			return;
		}

		if (answer?.ready === true && answer.findings !== undefined) {
			collection.set(document.uri, answer.findings.map((finding) => {
				const diagnostic = new vscode.Diagnostic(new vscode.Range(document.positionAt(finding.start), document.positionAt(finding.end)), finding.message, finding.dangerous ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Hint);

				diagnostic.source = "capabilities";
				diagnostic.code = 900100;

				return diagnostic;
			}));
		}

		// (the server or its engine not up yet, or the canary still running: asked again shortly)
		if ((answer?.ready !== true || answer.pending === true) && again < AGAIN) {
			schedule(document, AGAIN_MS, again + 1);
		}
	};

	function schedule(document: vscode.TextDocument, delay: number, again = 0): void {
		const key = document.uri.toString();

		clearTimeout(timers.get(key));
		timers.set(key, setTimeout(() => {
			timers.delete(key);
			void ask(document, again);
		}, delay));
	}

	context.subscriptions.push(
		collection,
		vscode.workspace.onDidOpenTextDocument((document) => {
			if (shown(document)) {
				schedule(document, 0);
			}
		}),
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (shown(event.document) && event.contentChanges.length > 0) {
				schedule(event.document, SETTLE_MS);
			}
		}),
		vscode.workspace.onDidCloseTextDocument((document) => {
			clearTimeout(timers.get(document.uri.toString()));
			timers.delete(document.uri.toString());
			collection.delete(document.uri);
		}),
		{ "dispose": () => {
			for (const timer of timers.values()) {
				clearTimeout(timer);
			}
		} }
	);

	for (const document of vscode.workspace.textDocuments.filter(shown)) {
		schedule(document, 0);
	}
}
