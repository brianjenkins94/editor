/**
 * What agents ask of the editor's extensions (debug-mcp's tools, over the hub): the bridge — the one extension on the
 * hub — answers each by the command of the extension whose it is (EXTENSION-POINTS 5). A fixed list, not a relay: a hub
 * request names an answer here, never a command.
 *
 * | hub request | tool | answered by |
 * | --- | --- | --- |
 * | `margin.state` { file? } | `margin_state` | the margin extension's `margin.state(file?)`: what a file's Margin shows |
 * | `rules.state` | `rules_list` | the capabilities extension's `silo.rules.list`: every rule as the Rules tree lists it |
 */
import type { Hub } from "@brianjenkins94/hub";
import { serve } from "@brianjenkins94/hub";
import * as vscode from "vscode";

const ANSWERS = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>([
	["margin.state", async ({ file }) => vscode.commands.executeCommand("margin.state", file)],
	["rules.state", async () => ({ "rules": await vscode.commands.executeCommand<unknown[] | null>("silo.rules.list") ?? [] })]
]);

export function serveAnswers(context: vscode.ExtensionContext, hub: Hub): void {
	for (const [subject, answer] of ANSWERS) {
		context.subscriptions.push({ "dispose": serve(hub, subject, async (args) => answer((args ?? {}) as Record<string, unknown>)) });
	}
}
