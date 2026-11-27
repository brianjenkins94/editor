import type { RulePlace } from "@brianjenkins94/editor-api";
import type { SpanRef } from "@brianjenkins94/editor-api/annotations";
import type { Policy, Predicate, Rule } from "@brianjenkins94/util/silo/policy";
import { annotations } from "@brianjenkins94/editor-api/annotations";
import { triggerOf } from "@brianjenkins94/editor-api/gate";
import { given, placesOf } from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";

function rowsOf(when: Predicate): string[] {
	return "predicates" in when ? when.predicates.flatMap(rowsOf) : [when.target_id];
}

function setsOf(rule: Rule): RulePlace["sets"] {
	if (rowsOf(rule.when).some((row) => row !== "at")) {
		return [];
	}

	return rule.then.flatMap((action) => (action.action_id === "set" && action.target_id?.startsWith("variables.") === true ? [{ "name": action.target_id.slice("variables.".length), "value": action.argument }] : []));
}

const lineAt = (text: string, offset: number): number => text.slice(0, offset).split("\n").length;

const TRIES = 3;

async function resolvedIn(text: string, file: string, refs: SpanRef[]): ReturnType<ReturnType<typeof annotations>["resolve"]> {
	for (let tries = 1; ; tries += 1) {
		const answer = await annotations(vscode.commands).resolve(text, file, refs);

		if ("value" in answer || tries === TRIES) {
			return answer;
		}

		await new Promise((resolve) => {
			setTimeout(resolve, 500 * tries);
		});
	}
}

async function placesFrom(policy: Policy): Promise<Record<string, RulePlace[]>> {
	const folder = vscode.workspace.workspaceFolders?.[0];
	const byFile = new Map<string, { "ref": SpanRef; "sets": RulePlace["sets"] }[]>();

	for (const rule of policy.rules) {
		const sets = setsOf(rule);

		for (const ref of sets.length === 0 ? [] : placesOf(rule) as SpanRef[]) {
			byFile.set(ref.file, [...byFile.get(ref.file) ?? [], { "ref": ref, "sets": sets }]);
		}
	}

	if (folder === undefined || byFile.size === 0) {
		return {};
	}

	const places: Record<string, RulePlace[]> = {};

	await Promise.all([...byFile].map(async ([file, placed]) => {
		const uri = vscode.Uri.joinPath(folder.uri, file);
		const text = await Promise.resolve(vscode.workspace.fs.readFile(uri)).then((bytes) => new TextDecoder().decode(bytes), () => undefined);

		if (text === undefined) {
			return;
		}

		const answer = await resolvedIn(text, file, placed.map(({ ref }) => ref));

		if (!("value" in answer)) {
			void vscode.window.showWarningMessage(`The rules placed in ${file} couldn't be found in it as it is now (${"unparsable" in answer ? answer.unparsable : answer.unavailable}), so this run goes without them.`);

			return;
		}

		places[uri.path] = answer.value.flatMap((found, index) => (found.candidate?.start === undefined || found.status === "uncertain" || found.status === "orphaned" ? [] : [{ "line": lineAt(text, found.candidate.start), "sets": placed[index].sets }]));
	}));

	return places;
}

export async function byRules(policy: Policy, program: string, config: vscode.DebugConfiguration): Promise<Record<string, unknown>> {
	const relative = program === "" ? "" : vscode.workspace.asRelativePath(program, false);
	const argv = config["args"] === undefined ? given(policy, { "program": relative, "trigger": triggerOf(config["__live"] === true) }, "process.argv")?.values[0] : undefined;

	return { "__places": await placesFrom(policy), ...Array.isArray(argv) ? { "args": argv } : {} };
}
