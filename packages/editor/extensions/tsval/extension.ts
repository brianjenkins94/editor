/**
 * tsval, the stepping debugger — an extension of the editor like any debugger's (EXTENSION-POINTS.md): a program run by
 * tsval's interpreter in a worker, with breakpoints, steps back as well as forward, capability stops, Explore Orderings
 * and a deterministic event loop.
 *
 * It reaches the editor only as another debugger's extension would: VS Code's API; the run contract
 * (@brianjenkins94/run-contract) — the events that tell the editor what a run did, the requests it answers; and the
 * workspace runtime, which worker-pod exports — its worker reads the workspace through it, and a server its program
 * starts answers the preview through it.
 */
import type { WorkspaceRuntime } from "@brianjenkins94/run-contract/runtime";
import * as vscode from "vscode";
import { registerTsvalDebug } from "./debug-adapter";

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const pod = vscode.extensions.getExtension<{ "workspaceRuntime"?: () => WorkspaceRuntime }>("brianjenkins94.worker-pod");
	const exports = await pod?.activate();

	if (exports?.workspaceRuntime === undefined) {
		throw new Error("tsval needs worker-pod's workspace runtime, and worker-pod didn't export one");
	}

	registerTsvalDebug(context, exports.workspaceRuntime());
}
