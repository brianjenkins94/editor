/**
 * The capability findings, shown: each open TypeScript/JavaScript document's (the plugin's `_capabilities.findings` —
 * engine.findings over the tree the TypeScript server holds) as this extension's own diagnostics — source
 * "capabilities", code 900100; a dangerous capability a warning, the rest a hint — so they're squiggles, in Problems
 * (the warnings) and in the hover.
 *
 * Asked of what's in an editor: once it's shown and has settled, once its edits have, and again while the canary is still
 * running (`pending`) or the server isn't up yet. Not of every document VS Code holds, nor the moment one opens: that's a request
 * to the server per model, a few of them each retried, before the server has been told of the file. The plugin only answers:
 * nothing is put into the TypeScript server's own diagnostics, so whatever hosts the readings later (TypeScript 7's API
 * connection) answers the same request.
 *
 * Each says how it's decided, and is as loud as that asks for (decisions.ts): a call a run would stop at, or that's denied, is
 * in Problems; one that's been allowed goes quiet. Its lightbulb decides it. And what people answered at it in their runs,
 * allowed once or refused (exceptions.ts).
 */
import type { ObservedExtension } from "@brianjenkins94/editor-api/runtime";
import * as vscode from "vscode";
import type { Finding } from "./decisions";
import { loadPolicyFiles } from "@brianjenkins94/editor-api/policy";
import type { Exceptions } from "./exceptions";
import { actionsFor, decisionOfCall, POLICY_FILES, sayDecision, severityOf } from "./decisions";

export const LANGUAGES = new Set(["typescript", "typescriptreact", "javascript", "javascriptreact"]);
/** How long edits settle before a document is asked about. */
const SETTLE_MS = 300;
/** How long a document's been shown before it's asked about: the TypeScript extension tells the server of it first. */
const SHOWN_MS = 1000;
/** How long apart, and how often, a document is asked again while its answer isn't final. */
const AGAIN_MS = 1000;
const AGAIN = 30;

/** What `_capabilities.findings` answers. */
interface Answer {
	"ready"?: boolean;
	"pending"?: boolean;
	"findings"?: Finding[];
}

/** A finding, where it is. */
interface Placed { "finding": Finding; "range": vscode.Range }

/** Calls `changed` when a policy file does. */
function watchPolicy(changed: () => Promise<void>): vscode.Disposable[] {
	const watcher = vscode.workspace.createFileSystemWatcher(POLICY_FILES);
	const again = (): void => {
		void changed();
	};

	return [watcher, watcher.onDidCreate(again), watcher.onDidChange(again), watcher.onDidDelete(again)];
}

export function publishFindings(context: vscode.ExtensionContext, exceptions: Exceptions, log?: ObservedExtension["log"]): void {
	const collection = vscode.languages.createDiagnosticCollection("capabilities");
	const timers = new Map<string, ReturnType<typeof setTimeout>>();
	/** Each document's findings as last answered, to say again when the policy changes, and for its lightbulb. */
	const placed = new Map<string, { "document": vscode.TextDocument; "found": Placed[] }>();

	/** A document's findings, shown as the policy has them now. */
	const show = async (uri: string): Promise<void> => {
		const known = placed.get(uri);

		if (known === undefined) {
			return;
		}

		const files = await loadPolicyFiles();

		// (closed meanwhile: its findings went with it)
		if (placed.get(uri) !== known) {
			return;
		}

		collection.set(known.document.uri, known.found.map(({ finding, range }) => {
			const decision = decisionOfCall(files, finding);
			const diagnostic = new vscode.Diagnostic(range, `${finding.message}. ${sayDecision(decision)}${exceptions.said(finding.capability, finding.resource)}`, severityOf(decision, finding));

			diagnostic.source = "capabilities";
			diagnostic.code = 900100;

			return diagnostic;
		}));
	};
	const showAll = async (): Promise<void> => {
		await Promise.all([...placed.keys()].map(show));
	};
	const shown = (document: vscode.TextDocument): boolean => document.uri.scheme === "file" && LANGUAGES.has(document.languageId) && vscode.window.visibleTextEditors.some((editor) => editor.document === document);

	const asked = async (document: vscode.TextDocument, again: number): Promise<void> => {
		// (no longer in an editor: asked again when it's back)
		if (document.isClosed || !shown(document)) {
			return;
		}

		const { version } = document;
		const response = await Promise.resolve(vscode.commands.executeCommand<{ "body"?: Answer } | undefined>("typescript.tsserverRequest", "_capabilities.findings", { "file": document.uri })).catch(() => undefined);
		const answer = response?.body;

		// (closed meanwhile, or edited: a later ask is on its way)
		if (document.isClosed || document.version !== version) {
			return;
		}

		if (answer?.ready === true && answer.findings !== undefined) {
			placed.set(document.uri.toString(), { "document": document, "found": answer.findings.map((finding) => ({ "finding": finding, "range": new vscode.Range(document.positionAt(finding.start), document.positionAt(finding.end)) })) });
			await show(document.uri.toString());
		}

		// (the server or its engine not up yet, or the canary still running: asked again shortly)
		if ((answer?.ready !== true || answer.pending === true) && again < AGAIN) {
			schedule(document, AGAIN_MS, again + 1);
		}
	};

	const ask = async (document: vscode.TextDocument, again: number): Promise<void> => {
		const asking = async (): Promise<void> => asked(document, again);

		await (log === undefined ? asking() : log.span("editor.extensions.capabilities.findings.ask", { "path": document.uri.path, "count": again }, asking));
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
		vscode.languages.registerCodeActionsProvider([...LANGUAGES].map((language) => ({ "language": language, "scheme": "file" })), {
			"provideCodeActions": async (document, range, code): Promise<vscode.CodeAction[]> => {
				const here = placed.get(document.uri.toString())?.found.filter((each) => each.range.intersection(range) !== undefined) ?? [];

				if (here.length === 0) {
					return [];
				}

				const files = await loadPolicyFiles();

				return here.flatMap(({ finding, range: at }) => actionsFor(files, finding).map(({ title, command }) => {
					const action = new vscode.CodeAction(title, vscode.CodeActionKind.QuickFix);

					action.command = command;
					action.diagnostics = code.diagnostics.filter((each) => each.source === "capabilities" && each.range.isEqual(at));

					return action;
				}));
			}
		}, { "providedCodeActionKinds": [vscode.CodeActionKind.QuickFix] }),
		// (decided anywhere: here, at a stop, or by editing the file)
		...watchPolicy(showAll),
		exceptions.onDidChange(() => {
			void showAll();
		}),
		vscode.window.onDidChangeVisibleTextEditors((editors) => {
			for (const { document } of editors) {
				if (shown(document) && !timers.has(document.uri.toString())) {
					schedule(document, SHOWN_MS);
				}
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
			placed.delete(document.uri.toString());
			collection.delete(document.uri);
		}),
		{ "dispose": () => {
			for (const timer of timers.values()) {
				clearTimeout(timer);
			}
		} }
	);

	for (const { document } of vscode.window.visibleTextEditors) {
		if (shown(document)) {
			schedule(document, SHOWN_MS);
		}
	}
}
