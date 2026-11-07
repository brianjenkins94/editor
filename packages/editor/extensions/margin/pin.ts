/**
 * What runs after an edit do with a call they can't make (RUNTIME-EVIDENCE.md, *Live runs*). Nobody is watching one, so it asks
 * nothing: a call it didn't make says so on its line in the Margin, with *Pin…*, a value past runs saw there kept as a rule, and
 * *Rule…*, any rule about it. Both are rules for those runs alone (`trigger is edit`), since a run you start can still ask.
 */
import type { ObservedExtension } from "@brianjenkins94/editor-api/runtime";
import type { Predicate, Rule } from "@brianjenkins94/util/silo/policy";
import { recordedResult, replaceRule } from "@brianjenkins94/editor-api/policy";
import * as vscode from "vscode";
import { keptRuns } from "./runs";

/** Only for runs after an edit. */
const AFTER_AN_EDIT: Predicate = { "target_id": "trigger", "operator_id": "is", "argument": "edit" };

/** A value a run kept as a preview (`'hi'`, `12`, `true`, `null`) as the value itself. Undefined for one that isn't a primitive:
 *  an object's preview can't be given back as it was. */
function previewed(text: string): { "value": unknown } | undefined {
	if (/^'[\s\S]*'$/u.test(text)) {
		return { "value": text.slice(1, -1).replaceAll("\\'", "'").replaceAll("\\\\", "\\") };
	}

	try {
		const value: unknown = JSON.parse(text);

		return value === null || ["number", "boolean", "string"].includes(typeof value) ? { "value": value } : undefined;
	} catch {
		return undefined;
	}
}

/** The values past runs saw at a call on `line` of `uri`: what it returned the last time it ran for real, then what was bound or
 *  returned on that line in the runs kept of the file, each once, the most seen first. */
async function pastValues(uri: string, capability: string, resource: string, line: number): Promise<{ "value": unknown; "label": string; "detail": string }[]> {
	const found = new Map<string, { "value": unknown; "label": string; "detail": string; "seen": number }>();
	const recorded = await recordedResult(capability, resource).catch(() => undefined);

	if (recorded !== undefined) {
		found.set(JSON.stringify(recorded.value), { "value": recorded.value, "label": typeof recorded.value === "string" ? `'${recorded.value}'` : JSON.stringify(recorded.value), "detail": "What it returned the last time it ran for real", "seen": Number.POSITIVE_INFINITY });
	}

	for (const trace of await keptRuns(vscode.workspace.asRelativePath(vscode.Uri.parse(uri), false))) {
		// (a run that didn't make the call saw its stand-in's value, or the one it was already given: nothing it returned)
		const made = !trace.values.some((value) => value.line === line && (value.kind === "skip" || value.kind === "given"));

		for (const value of made ? trace.values : []) {
			const parsed = value.line === line && (value.kind === "bind" || value.kind === "return") && value.value !== undefined ? previewed(value.value) : undefined;

			if (parsed !== undefined) {
				const key = JSON.stringify(parsed.value);
				const seen = found.get(key) ?? { "value": parsed.value, "label": value.value ?? "", "detail": `${value.name}, seen in a past run`, "seen": 0 };

				seen.seen += trace.count;
				found.set(key, seen);
			}
		}
	}

	return [...found.values()].toSorted((left, right) => right.seen - left.seen);
}

/** `rule`, for runs after an edit alone. */
function afterAnEdit(rule: Rule): Rule {
	return { ...rule, "when": { "logicalType_id": "all", "predicates": [AFTER_AN_EDIT, ...rule.when.predicates] } };
}

export function installPin(context: vscode.ExtensionContext, log?: ObservedExtension["log"]): void {
	const save = async (uri: string, capability: string, rule: Rule): Promise<void> => {
		const saving = async (): Promise<void> => replaceRule(undefined, rule);

		await (log === undefined ? saving() : log.span("editor.extensions.margin.pin.save", { "capability": capability }, saving));
		await Promise.resolve(vscode.commands.executeCommand("run.live.again", uri)).catch(() => undefined);
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("margin.pin", async (uri: string, capability: string, resource: string, line: number) => {
			const values = await pastValues(uri, capability, resource, line);

			if (values.length === 0) {
				void vscode.window.showInformationMessage(`Nothing's been seen of ${capability} ${resource}: once it runs for real (Run), what it returned is there to pin. Rule… gives any value.`);

				return;
			}

			const picked = await vscode.window.showQuickPick(values, { "title": `Pin ${capability} ${resource}`, "placeHolder": "What runs after an edit give it" });

			if (picked !== undefined) {
				await save(uri, capability, afterAnEdit({
					"when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": capability }, { "target_id": "resource", "operator_id": "is", "argument": resource }] },
					"then": [{ "action_id": "give", "target_id": "result", "argument": picked.value }]
				}));
			}
		}),
		vscode.commands.registerCommand("margin.unattended", async (uri: string, capability: string, resource: string) => {
			const rule = await vscode.commands.executeCommand<Rule | undefined>("capabilities.pickRule", capability, resource);

			if (rule !== undefined) {
				await save(uri, capability, afterAnEdit(rule));
			}
		})
	);
}
