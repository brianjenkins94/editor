/**
 * A file the editor's BABLR can't parse, said where it can't be missed: a warning on the file in the Problems view.
 * Nothing attaches to code BABLR can't parse — no runtime evidence is kept of it, no annotation finds it — so it's
 * never dropped without a word. The workbench's BABLR (workbench/bablr.ts) publishes `parse.status` for every file it
 * parses or fails to, with why; this is that status's VS Code face, and a file's warning goes when it parses again.
 */
import * as vscode from "vscode";
import { bridgeHub } from "./hub";

export function registerParseStatus(context: vscode.ExtensionContext): void {
	const diagnostics = vscode.languages.createDiagnosticCollection("BABLR");
	const root = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file("/workspace");

	context.subscriptions.push(diagnostics, { "dispose": bridgeHub.subscribe("parse.status", (data) => {
		const { file, unparsable } = (data ?? {}) as { "file"?: unknown; "unparsable"?: unknown };

		if (typeof file !== "string") {
			return;
		}

		const uri = file.startsWith("/") ? vscode.Uri.file(file) : vscode.Uri.joinPath(root, file);

		if (typeof unparsable !== "string") {
			diagnostics.delete(uri);

			return;
		}

		const diagnostic = new vscode.Diagnostic(new vscode.Range(0, 0, 0, Number.MAX_SAFE_INTEGER), `BABLR can't parse this file as it is (${unparsable}): runtime evidence and annotations can't attach to it until it does.`, vscode.DiagnosticSeverity.Warning);

		diagnostic.source = "BABLR";
		diagnostics.set(uri, [diagnostic]);
	}) });
}
