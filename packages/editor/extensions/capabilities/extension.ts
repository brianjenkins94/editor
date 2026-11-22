import { observeExtension } from "@brianjenkins94/editor-api/runtime";
import * as vscode from "vscode";
import { keepBaseline } from "./baseline";
import { installDecisions } from "./decisions";
import { readExceptions } from "./exceptions";
import { warnGrowth } from "./growth";
import { publishFindings } from "./findings";
import { installRulePicker } from "./rule-picker";

export function activate(context: vscode.ExtensionContext): void {
	const observed = observeExtension("capabilities", vscode);

	if (observed !== undefined) {
		context.subscriptions.push(observed);
	}

	installDecisions(context, observed?.log);
	installRulePicker(context, observed?.log);
	publishFindings(context, readExceptions(context), observed?.log);
	keepBaseline(context, observed?.log);
	warnGrowth(context, observed?.log);
}
