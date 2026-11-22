import type * as vscode from "vscode";
import { workspaceRuntime } from "@brianjenkins94/editor-api/runtime";
import { registerTsvalDebug } from "./debug-adapter";
import { registerExplore } from "./explore";
import { registerLiveRuns } from "./live-run";
import { registerRunFile } from "./run-file";

export function activate(context: vscode.ExtensionContext): void {
	const runtime = workspaceRuntime();

	if (runtime === undefined) {
		throw new Error("tsval needs the editor's workspace runtime, and this extension host has none");
	}

	registerTsvalDebug(context, runtime);
	registerExplore(context, runtime);
	registerRunFile(context);
	registerLiveRuns(context);
}
