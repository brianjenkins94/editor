import type { ObservedExtension } from "@brianjenkins94/editor-api/runtime";
import * as vscode from "vscode";
import type { Finding } from "./decisions";
import { loadPolicyFiles } from "@brianjenkins94/editor-api/policy";
import type { Exceptions } from "./exceptions";
import { actionsFor, decisionOfCall, POLICY_FILES, sayDecision, severityOf } from "./decisions";

export const LANGUAGES = new Set(["typescript", "typescriptreact", "javascript", "javascriptreact"]);
const SETTLE_MS = 300;
const SHOWN_MS = 1000;
const AGAIN_MS = 1000;
const AGAIN = 30;

interface Answer {
	"ready"?: boolean;
	"pending"?: boolean;
	"findings"?: Finding[];
}

interface Placed { "finding": Finding; "range": vscode.Range }

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
	const placed = new Map<string, { "document": vscode.TextDocument; "found": Placed[] }>();

	const show = async (uri: string): Promise<void> => {
		const known = placed.get(uri);

		if (known === undefined) {
			return;
		}

		const files = await loadPolicyFiles();

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
		if (document.isClosed || !shown(document)) {
			return;
		}

		const { version } = document;
		const response = await Promise.resolve(vscode.commands.executeCommand<{ "body"?: Answer } | undefined>("typescript.tsserverRequest", "_capabilities.findings", { "file": document.uri })).catch(() => undefined);
		const answer = response?.body;

		if (document.isClosed || document.version !== version) {
			return;
		}

		if (answer?.ready === true && answer.findings !== undefined) {
			placed.set(document.uri.toString(), { "document": document, "found": answer.findings.map((finding) => ({ "finding": finding, "range": new vscode.Range(document.positionAt(finding.start), document.positionAt(finding.end)) })) });
			await show(document.uri.toString());
		}

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

	const forget = (uri: vscode.Uri): void => {
		clearTimeout(timers.get(uri.toString()));
		timers.delete(uri.toString());
		placed.delete(uri.toString());
		collection.delete(uri);
	};
	const gone = vscode.workspace.createFileSystemWatcher("**/*", true, true, false);

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
			forget(document.uri);
		}),
		gone,
		gone.onDidDelete((uri) => {
			for (const each of [...placed.keys(), ...timers.keys()]) {
				const known = vscode.Uri.parse(each);

				if (known.path === uri.path || known.path.startsWith(`${uri.path}/`)) {
					forget(known);
				}
			}
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
