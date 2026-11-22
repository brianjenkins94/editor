import type { ObservedExtension } from "@brianjenkins94/editor-api/runtime";
import type { Rule } from "@brianjenkins94/util/silo/policy";
import { recordedResult, replaceRule } from "@brianjenkins94/editor-api/policy";
import { scopesOf } from "@brianjenkins94/editor-api/rules";
import * as vscode from "vscode";

async function pickValue(capability: string, resource?: string): Promise<{ "value": unknown } | undefined> {
	const recorded = resource === undefined ? undefined : await recordedResult(capability, resource);
	const typed = await vscode.window.showInputBox({ "title": `What ${capability}${resource === undefined ? "" : ` on ${resource}`} gives back`, "prompt": "JSON, or text", ...recorded === undefined ? {} : { "value": JSON.stringify(recorded.value) } });

	if (typed === undefined) {
		return undefined;
	}

	try {
		return { "value": JSON.parse(typed) as unknown };
	} catch {
		return { "value": typed };
	}
}

async function pickRule(capability: string, resource?: string): Promise<Rule | undefined> {
	const scope = await vscode.window.showQuickPick(scopesOf(capability, resource).map((each) => ({ ...each })), { "title": `A rule about ${capability}${resource === undefined ? "" : ` on ${resource}`}`, "placeHolder": "What should it cover?" });

	if (scope === undefined) {
		return undefined;
	}

	const what = await vscode.window.showQuickPick([
		{ "label": "Allow", "description": "Let it run, for real", "action": "allow" },
		{ "label": "Skip", "description": "Don't make it: the run goes on as if it did nothing", "action": "skip" },
		{ "label": "Deny", "description": "Fail it, as a denied call does (EACCES)", "action": "deny" },
		{ "label": "Give a value…", "description": "Don't make it: it returns what you say", "action": "give" }
	], { "title": scope.label, "placeHolder": "What should happen?" });

	if (what === undefined) {
		return undefined;
	}

	if (what.action !== "give") {
		return { "when": scope.when, "then": [{ "action_id": what.action }] };
	}

	const given = await pickValue(capability, resource);

	return given === undefined ? undefined : { "when": scope.when, "then": [{ "action_id": "give", "target_id": "result", "argument": given.value }] };
}

export function installRulePicker(context: vscode.ExtensionContext, log?: ObservedExtension["log"]): void {
	const save = async (rule: Rule): Promise<void> => replaceRule(undefined, rule);

	context.subscriptions.push(
		vscode.commands.registerCommand("capabilities.makeRule", async (capability: string, resource?: string) => {
			const rule = await pickRule(capability, resource);

			if (rule !== undefined) {
				await (log === undefined ? save(rule) : log.span("editor.extensions.capabilities.rule-picker.save", { "capability": capability }, async () => save(rule)));
			}
		}),
		vscode.commands.registerCommand("capabilities.pickRule", pickRule),
		vscode.commands.registerCommand("capabilities.pickValue", pickValue)
	);
}
