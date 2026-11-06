/**
 * The rule editor is a picker, opened from a call's lightbulb or a stop: what a rule covers, then what happens, or the value a
 * call gives back. It isn't a form of every row a rule can have (the old Rule view), which is what the policy file is for, with
 * its schema: this is the rule someone wants at the moment they're looking at the call. The user, 2026-11-06: nothing to go
 * and look at. RUNNING.md, *Rules*.
 */
import type { ObservedExtension } from "@brianjenkins94/editor-api/runtime";
import type { Rule } from "@brianjenkins94/util/silo/policy";
import { recordedResult, replaceRule } from "@brianjenkins94/editor-api/policy";
import { scopesOf } from "@brianjenkins94/editor-api/rules";
import * as vscode from "vscode";

/** A value someone types for a call to return: starting from what it returned last, read as JSON if it is, else as text.
 *  Undefined: they didn't. */
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

/** A rule about a call, as someone picks it: what it covers, then what happens. Undefined: they didn't. Anything more
 *  particular is an edit to the policy file. */
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
		// From the lightbulb: the rule saved. From a stop, the stop saves it, as it decides the call by it.
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
