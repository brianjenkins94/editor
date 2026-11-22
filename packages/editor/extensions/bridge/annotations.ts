import { createRpcClient } from "@brianjenkins94/hub";
import * as vscode from "vscode";
import { bridgeHub } from "./hub";

export function registerAnnotations(context: vscode.ExtensionContext): void {
	const rpc = createRpcClient(bridgeHub);

	context.subscriptions.push(vscode.commands.registerCommand("editor.annotations.classify", async (before: unknown, after: unknown) => rpc.request("annotations.classify", { "before": before, "after": after }, { "timeoutMs": 120_000, "waitForResponderMs": 30_000 })));
}
