/**
 * Capabilities: what a program's calls can reach, shown in the code (ARCHITECTURE.md at the `full-editor` tag, *Capabilities*).
 * The tsserver plugin (ts-plugin.js) answers `_capabilities.findings`, from the tree the server holds and a sandboxed
 * background run of the file (tsval's canary.ts), and findings.ts shows them as this extension's diagnostics.
 *
 * What else this extension did (the Capability calls panel, the dependency baseline, Exceptions, rules) comes back with those
 * features.
 */
import { observeExtension } from "@brianjenkins94/editor-api/runtime";
import type * as vscode from "vscode";
import { publishFindings } from "./findings";

export function activate(context: vscode.ExtensionContext): void {
	const observed = observeExtension("capabilities");

	if (observed !== undefined) {
		context.subscriptions.push(observed);
	}

	publishFindings(context, observed?.log);
}
