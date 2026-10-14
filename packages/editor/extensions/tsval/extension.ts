/**
 * tsval, the stepping debugger — an extension of the editor like any debugger's (EXTENSION-POINTS.md): a program run by
 * tsval's interpreter in a worker, with breakpoints, steps back as well as forward, capability stops, Explore Orderings
 * and a deterministic event loop.
 *
 * It reaches the editor only as another debugger's extension would: VS Code's API; the run contract
 * (@brianjenkins94/editor-api) — the events that tell the editor what a run did, the requests it answers; and the
 * workspace runtime (`workspaceRuntime()`, which the bridge provides in this extension host — the one tsval depends on)
 * — its worker reads the workspace through it, and a server its program starts answers the preview through it.
 */
import type * as vscode from "vscode";
import { workspaceRuntime } from "@brianjenkins94/editor-api/runtime";
import { registerTsvalDebug } from "./debug-adapter";

export function activate(context: vscode.ExtensionContext): void {
	const runtime = workspaceRuntime();

	if (runtime === undefined) {
		throw new Error("tsval needs the editor's workspace runtime, and this extension host has none");
	}

	registerTsvalDebug(context, runtime);
}
