/**
 * The Margin (RUNTIME-EVIDENCE.md, *Live values*): the file's runtime column, a pane view beside the code (EXTENSION-POINTS.md, 4) — a run's
 * values, a capability stop's question, how the last run ended, the program's steps (margin.ts), and coverage in its
 * gutter column (coverage.ts) — from every debugger's run contract events, on public API but for the commands
 * EXTENSION-POINTS lists (5): the bridge's decide, set value and Run, the capabilities extension's rules and statements,
 * core's Rule view.
 */
import { evidenceStore } from "@brianjenkins94/editor-api/evidence";
import { observeExtension } from "@brianjenkins94/editor-api/runtime";
import * as vscode from "vscode";
import { installCoverage } from "./coverage";
import { registerMargin, showMarks, showProfile } from "./margin";

export function activate(context: vscode.ExtensionContext): void {
	// On the editor's observability plane, as any extension can be (editor-api's observeExtension): its log.
	const observed = observeExtension("margin");

	if (observed !== undefined) {
		context.subscriptions.push(observed);
		observed.log.info("the Margin is up");
	}

	registerMargin(observed?.log);
	// Coverage's marks, into the Margin: each session's report, and the evidence kept in git.
	installCoverage(vscode, evidenceStore(vscode, context.subscriptions), showMarks, showProfile);
}
