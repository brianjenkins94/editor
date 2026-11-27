import type { EvidenceStore, PlacedChange } from "@brianjenkins94/editor-api/evidence";
import * as vscode from "vscode";
import { branchSite, valueSite } from "./hover";

const CODE = /\.(?:ts|tsx|js|jsx|mjs|cjs)$/u;

const IMPURE = { "write": "writes outside itself", "effect": "makes an effect", "nondeterministic": "reads the clock or random numbers", "unwatched": "calls code runs can't see into" };

export function said({ change, type }: Pick<PlacedChange, "change" | "type">): string {
	switch (change.kind) {
		case "reached":
			return "Since the last commit, this runs: it hadn't.";

		case "value": {
			const what = [...change.nullish ? ["nullish now"] : [], ...change.tags.length > 0 ? [`now also ${change.tags.map((tag) => `\`${tag}\``).join(", ")}`] : []];

			return `Since the last commit, ${valueSite(type).replaceAll("`", "")}: ${what.join("; ")}.`;
		}

		case "branch": {
			const { name, arms } = branchSite(type);

			return `Since the last commit, ${name.replaceAll("`", "")}: ${change.taken.map((arm) => arms[arm] ?? `arm ${String(arm + 1)}`).join(", ")} taken now.`;
		}

		case "purity":
			return `Since the last commit, it ${change.impure.map((kind) => IMPURE[kind]).join(", ")}.`;

		default:
			return "Since the last commit, its runs differ.";
	}
}

export function registerChanges(context: vscode.ExtensionContext, store: EvidenceStore): void {
	const diagnostics = vscode.languages.createDiagnosticCollection("evidence-changes");

	const check = async (document: vscode.TextDocument): Promise<void> => {
		if (!CODE.test(document.uri.path)) {
			return;
		}

		const changes = await store.changes(document);

		if (changes === undefined) {
			return;
		}

		diagnostics.set(document.uri, changes.map((placed) => {
			const diagnostic = new vscode.Diagnostic(new vscode.Range(document.positionAt(placed.start), document.positionAt(placed.end)), said(placed), vscode.DiagnosticSeverity.Information);

			diagnostic.source = "since the last commit";

			return diagnostic;
		}));
	};

	const checkVisible = (): void => {
		for (const editor of vscode.window.visibleTextEditors) {
			void check(editor.document);
		}
	};

	let typing: ReturnType<typeof setTimeout> | undefined;

	context.subscriptions.push(
		diagnostics,
		store.onDidChange(checkVisible),
		vscode.window.onDidChangeVisibleTextEditors(checkVisible),
		vscode.workspace.onDidSaveTextDocument(checkVisible),
		vscode.workspace.onDidChangeTextDocument((event) => {
			if (event.contentChanges.length > 0) {
				clearTimeout(typing);
				typing = setTimeout(() => {
					void check(event.document);
				}, 400);
			}
		}),
		vscode.workspace.onDidCloseTextDocument((document) => {
			diagnostics.delete(document.uri);
		})
	);
	checkVisible();
}
