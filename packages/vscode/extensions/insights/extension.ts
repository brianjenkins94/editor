/**
 * Insights — what a program did when it ran, and what the editor is doing, shown as it happens, with nothing to ask for.
 * The monitor (the metrics plane in the status bar and a view of sparkline cards) is monitor.ts; coverage — every run's,
 * marked in the gutter of the file it ran — is coverage.ts; what went through the code under the cursor — values and
 * branches, across runs — is hover.ts; what runs say could go — a `?.` or `??` never needed, a branch never taken —
 * is fixes.ts; all three read the evidence kept in git through evidence.ts; a slow preview's profile, with where its
 * time went, is profiles.ts.
 */
import type * as vscode from "vscode";
import { registerCoverage } from "./coverage";
import { evidenceStore } from "./evidence";
import { registerFixes } from "./fixes";
import { registerHover } from "./hover";
import { registerMonitor } from "./monitor";
import { registerProfiles } from "./profiles";

export function activate(context: vscode.ExtensionContext): void {
	registerMonitor(context);
	const store = evidenceStore(context);

	registerCoverage(context, store);
	registerHover(context, store);
	registerFixes(context, store);
	registerProfiles(context);
}
