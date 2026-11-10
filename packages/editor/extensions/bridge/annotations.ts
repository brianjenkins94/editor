/**
 * The editor's BABLR, for extensions (ARCHITECTURE.md, *Extension points* 5; editor-api's annotations()): what a change
 * from one text to another is, cosmetic or meaningful, asked of the workbench (workbench/bablr.ts `annotations.classify`)
 * so every extension shares its worker and the parses it keeps. Answered `{ value }` or `{ unparsable }`.
 */
import { createRpcClient } from "@brianjenkins94/hub";
import * as vscode from "vscode";
import { bridgeHub } from "./hub";

export function registerAnnotations(context: vscode.ExtensionContext): void {
	const rpc = createRpcClient(bridgeHub);

	context.subscriptions.push(vscode.commands.registerCommand("editor.annotations.classify", async (before: unknown, after: unknown) => rpc.request("annotations.classify", { "before": before, "after": after }, { "timeoutMs": 120_000, "waitForResponderMs": 30_000 })));
}
