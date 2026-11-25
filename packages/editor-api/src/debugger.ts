/**
 * The debugger a run of a file starts — Run (▷), live runs, an agent's run — by its debug type: tsval, or another
 * extension's, an interpreter plugged in (editor-contrib's template, contrib/README.md). What's tsval's own keeps to it: a
 * terminal's `node`, tests, a recorded stop, exploring orderings.
 */
import * as vscode from "vscode";

export function runDebugger(): string {
	return vscode.workspace.getConfiguration("run").get<string>("debugger") || "tsval";
}
