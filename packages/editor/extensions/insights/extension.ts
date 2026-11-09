/**
 * Insights: what a program did when it ran, read from the evidence kept in git (RUNTIME-EVIDENCE.md), shown where the
 * code is, with nothing to ask for. On hover, what went through the code under the cursor across runs (hover.ts); in
 * purple, what runs say could go — a `?.` or `??` never needed, a branch never taken, code never run — with its fix in the
 * lightbulb (fixes.ts, found by suggestions.ts). And where a preview's time went, as each profile of it is kept
 * (profiles.ts).
 */
import { evidenceStore } from "@brianjenkins94/editor-api/evidence";
import * as vscode from "vscode";
import { registerFixes } from "./fixes";
import { registerHover } from "./hover";
import { registerProfiles } from "./profiles";

export function activate(context: vscode.ExtensionContext): void {
	const store = evidenceStore(vscode, context.subscriptions);

	registerHover(context, store);
	registerFixes(context, store);
	registerProfiles(context);
}
