/**
 * Capabilities: what a program's calls can reach, shown in the code (ARCHITECTURE.md at the `full-editor` tag, *Capabilities*).
 * The tsserver plugin (ts-plugin.js) answers `_capabilities.findings`, from the tree the server holds and a sandboxed
 * background run of the file (tsval's canary.ts), and findings.ts shows them as this extension's diagnostics.
 *
 * A call's decision is on the call (decisions.ts): the diagnostic says how it's decided and by what, and its lightbulb
 * changes that. There's no view of them to go and look at (the user, 2026-11-06). The dependency baseline comes back with
 * its feature.
 */
import { observeExtension } from "@brianjenkins94/editor-api/runtime";
import type * as vscode from "vscode";
import { installDecisions } from "./decisions";
import { publishFindings } from "./findings";

export function activate(context: vscode.ExtensionContext): void {
	const observed = observeExtension("capabilities");

	if (observed !== undefined) {
		context.subscriptions.push(observed);
	}

	installDecisions(context, observed?.log);
	publishFindings(context, observed?.log);
}
