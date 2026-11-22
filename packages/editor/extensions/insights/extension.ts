import { evidenceStore } from "@brianjenkins94/editor-api/evidence";
import * as vscode from "vscode";
import { registerFixes } from "./fixes";
import { registerHover } from "./hover";
import { registerMonitor } from "./monitor";
import { registerTimes } from "./times";

export function activate(context: vscode.ExtensionContext): void {
	const store = evidenceStore(vscode, context.subscriptions);

	registerHover(context, store);
	registerFixes(context, store);
	registerTimes(context, store);
	registerMonitor(context);
}
