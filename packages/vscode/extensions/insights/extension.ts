/**
 * Insights — what a program did when it ran, and what the editor is doing, shown as it happens, with nothing to ask for.
 * The monitor (the metrics plane in the status bar and a view of sparkline cards) is monitor.ts; coverage — every run's,
 * marked in the gutter of the file it ran — is coverage.ts.
 */
import type * as vscode from "vscode";
import { registerCoverage } from "./coverage";
import { registerMonitor } from "./monitor";

export function activate(context: vscode.ExtensionContext): void {
	registerMonitor(context);
	registerCoverage(context);
}
