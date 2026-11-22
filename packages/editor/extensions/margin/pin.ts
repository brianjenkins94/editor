import type { ObservedExtension } from "@brianjenkins94/editor-api/runtime";
import type { Predicate, Rule } from "@brianjenkins94/util/silo/policy";
import type { RunTrace } from "@brianjenkins94/util/silo/traces";
import { Anchors } from "@brianjenkins94/editor-api/anchors";
import { recordedResult, replaceRule } from "@brianjenkins94/editor-api/policy";
import * as vscode from "vscode";
import { keptRuns } from "./runs";

const AFTER_AN_EDIT: Predicate = { "target_id": "trigger", "operator_id": "is", "argument": "edit" };

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

async function linesIn(trace: RunTrace, path: string, source: string | undefined): Promise<(number | undefined)[]> {
	if (source === undefined || trace.source === undefined || trace.source === source) {
		return trace.values.map((value) => value.line);
	}

	const lines = await new Anchors(vscode, path, trace.source).lines(source, trace.values.map((value) => value.at ?? [0, 0]));

	return trace.values.map((value, index) => (value.at === undefined ? undefined : lines[index]));
}

async function pastValues(uri: string, capability: string, resource: string, line: number, source?: string): Promise<{ "value": unknown; "label": string; "detail": string }[]> {
	const found = new Map<string, { "value": unknown; "label": string; "detail": string; "seen": number }>();
	const recorded = await recordedResult(capability, resource).catch(() => undefined);

	if (recorded !== undefined) {
		found.set(JSON.stringify(recorded.value), { "value": recorded.value, "label": typeof recorded.value === "string" ? `'${recorded.value}'` : JSON.stringify(recorded.value), "detail": "What it returned the last time it ran for real", "seen": Number.POSITIVE_INFINITY });
	}

	for (const trace of await keptRuns(vscode.workspace.asRelativePath(vscode.Uri.parse(uri), false))) {
		const lines = await linesIn(trace, vscode.Uri.parse(uri).path, source);
		const made = !trace.values.some((value, index) => lines[index] === line && (value.kind === "skip" || value.kind === "given"));

		for (const [index, value] of made ? trace.values.entries() : []) {
			const parsed = lines[index] === line && (value.kind === "bind" || value.kind === "return") && value.value !== undefined ? previewed(value.value) : undefined;

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
		vscode.commands.registerCommand("margin.pin", async (uri: string, capability: string, resource: string, line: number, source?: string) => {
			const values = await pastValues(uri, capability, resource, line, source);

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
