/**
 * How a capability call is decided, said on the call: the policy's answer for it and the rule that gives it (or that nothing
 * does), how loud that should be, and the lightbulb's ways of changing it. There's no list of calls or rules to go and look
 * at, since nobody does (the user, 2026-11-06). The whole list, for when it's wanted, is the policy file itself, with each
 * rule's sentence above it.
 *
 * A call is decided as a run decides it (`effectiveDisposition`, the first rule that matches, my rules ahead of the shared
 * contract), so what's said here is what a run does: `review` is a stop.
 */
import type { ObservedExtension } from "@brianjenkins94/editor-api/runtime";
import type { Effective, Rule } from "@brianjenkins94/util/silo/policy";
import { loadPolicyFiles, persistOverride, replaceRule } from "@brianjenkins94/editor-api/policy";
import { catalogOf, describeRule } from "@brianjenkins94/editor-api/rules";
import * as policy from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";

/** One finding, as the plugin answers it (engine.ts). */
export interface Finding {
	"start": number;
	"end": number;
	"dangerous": boolean;
	"message": string;
	"capability": string;
	"resource"?: string;
}

export type PolicyFiles = Awaited<ReturnType<typeof loadPolicyFiles>>;

/** What decides a call: its answer, and the rule that gave it (none: the default). */
export interface Decision {
	"effective": Effective | "give";
	"rule"?: Rule;
	"whose"?: "mine" | "shared";
}

/** The policy files, for a file watcher and a selector. */
export const POLICY_FILES = "**/.silo/{policy.json,policy/*.json}";

const DECISIONS = ["allow", "deny", "skip", "ask"];
const catalog = catalogOf(policy);

/** How `finding` is decided. An unknown resource is "", as a run's stop has it. */
export function decisionOfCall(files: PolicyFiles, { capability, resource = "" }: Finding): Decision {
	const rules = (whose: "mine" | "shared"): Rule[] => files?.[whose].rules ?? [];
	const all = { ...policy.EMPTY_POLICY, "rules": [...rules("mine"), ...rules("shared")] };
	const subject = { "capability": capability, "resource": resource, "trigger": "you" };
	// (a rule giving its result decides it first, as a run does: extensions/tsval/worker/gate.ts)
	const gives = policy.givenResult(all, subject) !== undefined;
	const effective = gives ? "give" : policy.effectiveDisposition(all, capability, resource, policy.isDangerous(capability), { "trigger": "you" });
	const of = (whose: "mine" | "shared"): Rule | undefined => policy.ruleFor({ ...policy.EMPTY_POLICY, "rules": rules(whose) }, subject, gives ? ["give"] : DECISIONS);
	const mine = of("mine");
	const shared = mine === undefined ? of("shared") : undefined;

	return { "effective": effective, ...mine === undefined ? {} : { "rule": mine, "whose": "mine" }, ...shared === undefined ? {} : { "rule": shared, "whose": "shared" } } as Decision;
}

const SAID: Record<Decision["effective"], string> = { "allow": "Allowed", "deny": "Denied", "skip": "Skipped", "give": "Given", "review": "Undecided" };

/** A call's decision, as its diagnostic says it. */
export function sayDecision({ effective, rule, whose }: Decision): string {
	if (rule === undefined) {
		return effective === "review" ? "Undecided: a run stops here and asks" : "Allowed by default";
	}

	return `${SAID[effective]} by ${whose === "mine" ? "your rule" : "the shared policy"}: ${describeRule(rule, catalog)}`;
}

/** How loud a call's decision is: what's waiting on someone or refused is in Problems, what's been allowed is quiet. */
export function severityOf({ effective }: Decision, { dangerous }: Finding): vscode.DiagnosticSeverity {
	switch (effective) {
		case "deny":
			return vscode.DiagnosticSeverity.Error;
		case "skip":
		case "give":
			return vscode.DiagnosticSeverity.Information;
		case "review":
			return dangerous ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Hint;
		default:
			return vscode.DiagnosticSeverity.Hint;
	}
}

const VERBS: [Exclude<Effective, "review">, string][] = [["allow", "Allow"], ["skip", "Skip"], ["deny", "Deny"]];

/** What the lightbulb on `finding` offers: its other answers, always (none before its resource is known: a rule needs one),
 *  and the rule that decides it, to take out when it's mine or to look at. */
export function actionsFor(files: PolicyFiles, finding: Finding): { "title": string; "command": vscode.Command }[] {
	const { effective, rule, whose } = decisionOfCall(files, finding);
	const { capability, resource } = finding;
	const action = (title: string, command: string, ...args: unknown[]): { "title": string; "command": vscode.Command } => ({ "title": title, "command": { "title": title, "command": command, "arguments": args } });

	return [
		...resource === undefined ? [] : VERBS.filter(([disposition]) => disposition !== effective).map(([disposition, verb]) => action(`${verb} ${capability} on ${resource}, always`, "capabilities.decide", capability, resource, disposition)),
		action("Make a rule for this call…", "capabilities.makeRule", capability, resource),
		...rule === undefined || whose !== "mine" ? [] : [action(`Take out your rule: ${describeRule(rule, catalog)}`, "capabilities.takeOut", rule)],
		...rule === undefined ? [] : [action(`Open the rule, in ${files?.[whose ?? "mine"].file ?? "the policy"}`, "capabilities.openRules", whose, rule)]
	];
}

/** Where each rule of `text` starts: at its own `when` (a rule's conditions nest under `predicates`, with no other). */
const whenOffsets = (text: string): number[] => [...text.matchAll(/"when"/gu)].map((match) => match.index);

export function installDecisions(context: vscode.ExtensionContext, log?: ObservedExtension["log"]): void {
	const span = async <T>(word: string, attrs: Record<string, string>, work: () => Promise<T>): Promise<T> => (log === undefined ? work() : log.span(`editor.extensions.capabilities.decisions.${word}`, attrs, work));

	/** A policy file by its workspace-relative path, made if it isn't there yet. */
	const fileOf = async (relative: string): Promise<vscode.Uri | undefined> => {
		const folder = vscode.workspace.workspaceFolders?.[0];

		if (folder === undefined) {
			return undefined;
		}

		const uri = vscode.Uri.joinPath(folder.uri, relative);

		await Promise.resolve(vscode.workspace.fs.stat(uri)).catch(async () => {
			await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`${JSON.stringify(policy.EMPTY_POLICY, null, "\t")}\n`));
		});

		return uri;
	};

	context.subscriptions.push(
		vscode.commands.registerCommand("capabilities.decide", async (capability: string, resource: string, disposition: "allow" | "skip" | "deny") => {
			await span("decide", { "op": disposition, "capability": capability }, async () => persistOverride(capability, resource, disposition));
		}),
		vscode.commands.registerCommand("capabilities.takeOut", async (rule: Rule) => {
			await span("takeOut", {}, async () => replaceRule(rule, undefined));
		}),
		// The whole list, when it's wanted: my policy file, or the rule asked for, in whichever file it's in.
		vscode.commands.registerCommand("capabilities.openRules", async (whose: "mine" | "shared" = "mine", rule?: Rule) => {
			await span("open", { "op": whose }, async () => {
				const files = await loadPolicyFiles();
				const uri = files === undefined ? undefined : await fileOf(files[whose].file);

				if (files === undefined || uri === undefined) {
					return;
				}

				const document = await vscode.workspace.openTextDocument(uri);
				const at = rule === undefined ? -1 : files[whose].rules.findIndex((each) => JSON.stringify(each.when) === JSON.stringify(rule.when));
				const offset = at === -1 ? undefined : whenOffsets(document.getText())[at];
				const position = offset === undefined ? undefined : document.positionAt(offset);

				await vscode.window.showTextDocument(document, position === undefined ? {} : { "selection": new vscode.Range(position, position) });
			});
		}),
		// A rule's sentence above it, in its file.
		vscode.languages.registerCodeLensProvider({ "pattern": POLICY_FILES }, {
			"provideCodeLenses": (document) => {
				const text = document.getText();
				let rules: Rule[];

				try {
					({ rules } = policy.parsePolicy(text));
				} catch {
					return [];
				}

				const starts = whenOffsets(text);

				return rules.flatMap((rule, index) => {
					const start = starts[index];

					return start === undefined ? [] : [new vscode.CodeLens(new vscode.Range(document.positionAt(start), document.positionAt(start)), { "title": describeRule(rule, catalog), "command": "" })];
				});
			}
		})
	);
}
