/**
 * The Rules view (RUNNING.md, *Rules*), as VS Code's own tree view, in the Explorer beside Capability calls: every rule
 * in the policy files — mine first (`.silo/policy/<you>.json`), then the shared contract's (`.silo/policy.json`) — each
 * a sentence in the catalog's words, in the order they're matched: the first that matches decides. A placed rule says
 * the line its statement is on now; one that can't be matched, or whose place is lost, says why.
 *
 * Its commands (ARCHITECTURE.md, *Extension points* 5): `silo.rules.list` — every rule as it shows them (an agent's `rules_list` too); a rule
 * opens in core's Rule view below (`silo.rules.open`, by `editor.rules.edit`: *Save*, *Re-place at selection* a lost
 * one, *Remove* mine, *Cancel*), *New Rule* starts one (`silo.rules.new`), *Remove* takes one of mine out and
 * Re-place at selection* places a lost one at the code selected (`silo.rules.remove`, `.replace`: inline). The rules
 * themselves, and their places, are rules.ts'. Redrawn as the policy files change, and as files are saved (a placed rule
 * follows its code).
 */
import type { EditAnswer, EditButton } from "@brianjenkins94/editor-api/rules";
import type { Rule } from "@brianjenkins94/util/silo/policy";
import type { PlaceNow } from "./rules";
import { annotations } from "@brianjenkins94/editor-api/annotations";
import { catalogOf, describeRule, variablesOf, withVariables } from "@brianjenkins94/editor-api/rules";
import { POLICY_GLOB } from "@brianjenkins94/util/silo/layout";
import * as policy from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";
import { rulesFiles, setRule, withPlace } from "./rules";

/** A rule as the tree lists it (`silo.rules.list`, and an agent's `rules_list`). */
interface Listed { "whose": "mine" | "shared"; "file": string; "sentence": string; "problem"?: string; "place"?: PlaceNow; "rule": Rule }

/** A new rule, as it starts: one row to fill in, and allow. */
const BLANK: Rule = { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "" }] }, "then": [{ "action_id": "allow" }] };

/** silo's catalog, with the variables `rule` names. */
const catalogFor = (rule: Rule): ReturnType<typeof withVariables> => (variablesOf(rule).length === 0 ? catalogOf(policy) : withVariables(policy, variablesOf(rule).map((name) => ({ "name": name, "kind": "" }))));

/** The span reference of the code selected in the editor, for a rule whose place is lost — or why there isn't one. */
async function selected(): Promise<unknown> {
	const editor = vscode.window.activeTextEditor;

	if (editor === undefined || editor.selection.isEmpty) {
		throw new Error("Select the statement it belongs at, in the editor, first");
	}

	const { document, selection } = editor;
	const answer = await annotations(vscode.commands).refer(document.getText(), vscode.workspace.asRelativePath(document.uri, false), [{ "start": document.offsetAt(selection.start), "end": document.offsetAt(selection.end) }]);

	if ("unparsable" in answer) {
		throw new Error(`That code can't be placed: its file can't be parsed as it is (${answer.unparsable})`);
	}

	if ("unavailable" in answer) {
		throw new Error(`That code can't be placed: the editor's BABLR isn't available (${answer.unavailable})`);
	}

	const [place] = answer.value;

	if (place === undefined || place === null) {
		throw new Error("That code can't be placed: nothing there a rule can stand at — select a statement");
	}

	return place;
}

/** Every rule, as the tree lists it: mine, then the shared contract's — or null without a folder. */
async function listed(): Promise<Listed[] | null> {
	const files = await rulesFiles().catch(() => null);

	if (files === null) {
		return null;
	}

	const each = (whose: "mine" | "shared", { file, rules, places }: { "file": string; "rules": Rule[]; "places": (PlaceNow | null)[] }): Listed[] => rules.map((rule, index) => {
		const place = places[index] ?? null;
		// A rule whose place in the code is lost can't apply: as broken as one that can't be matched. Nor can one whose
		// file can't be parsed as it is — though its place isn't lost, and it applies again once the file parses.
		const problem = policy.problemOf(rule) ?? (place?.status === "orphaned" ? "Its place in the code is lost — the statement it was at is gone or changed past recognizing" : undefined) ?? (place?.status === "unparsable" ? `Where it applies can't be told: its file can't be parsed as it is (${place.why ?? "BABLR can't parse it"})` : undefined);

		return { "whose": whose, "file": file, "sentence": problem === undefined ? describeRule(rule, catalogFor(rule)) : `${problem} — it matches nothing`, ...problem === undefined ? {} : { "problem": problem }, ...place === null ? {} : { "place": place }, "rule": rule };
	});

	return [...each("mine", files.mine), ...each("shared", files.shared)];
}

/** A command's rule: the tree's listed rule — or its node, from an inline action. */
function ruleOf(argument: unknown): Listed | undefined {
	const value = argument as { "listed"?: Listed } & Partial<Listed> | undefined;

	return value?.listed ?? (value?.rule === undefined ? undefined : value as Listed);
}

type Node = { "kind": "group"; "whose": "mine" | "shared"; "file": string; "rules": Listed[] } | { "kind": "rule"; "listed": Listed };

/** How a placed rule was found now, when that's not surely: it doesn't apply until it's placed again. */
function placing(listed: Listed): "lost" | "uncertain" | undefined {
	const status = listed.place?.status;

	if (status === "orphaned") {
		return "lost";
	}

	return status === "uncertain" ? "uncertain" : undefined;
}

/** What the view says over its rules when there are none to show. */
function emptyMessage(rules: Listed[] | null): string | undefined {
	if (rules === null) {
		return "Open a folder to keep rules: they live in its .silo/ folder.";
	}

	return rules.length === 0 ? "None yet — make one with New Rule above, Rule… at a capability stop, or Mock… on process.argv's row." : undefined;
}

/** What's to know about a rule's place, for its tooltip. */
function placeNote(listed: Listed, found: "lost" | "uncertain" | undefined): string | undefined {
	if (listed.problem !== undefined) {
		return "Open it to fix it";
	}

	if (found === "uncertain") {
		return `Line ${listed.place?.line}, found by a match not sure enough to act on: it doesn't apply until it's placed again`;
	}

	return listed.place?.line !== undefined ? `Its statement is on line ${listed.place.line} now` : undefined;
}

export function registerRulesTree(context: vscode.ExtensionContext): void {
	const changed = new vscode.EventEmitter<void>();
	let listing: Promise<Listed[] | null> | undefined;
	const list = async (): Promise<Listed[] | null> => {
		listing ??= listed().catch(() => null);

		return listing;
	};

	const provider: vscode.TreeDataProvider<Node> = {
		"onDidChangeTreeData": changed.event,
		"getChildren": async (node) => {
			if (node !== undefined) {
				return node.kind === "group" ? node.rules.map((listed) => ({ "kind": "rule", "listed": listed })) : [];
			}

			const rules = await list();

			showMessage(emptyMessage(rules));

			if (rules === null || rules.length === 0) {
				return [];
			}

			const mine = rules.filter((listed) => listed.whose === "mine");
			const shared = rules.filter((listed) => listed.whose === "shared");

			return [
				...mine.length === 0 ? [] : [{ "kind": "group", "whose": "mine", "file": mine[0].file, "rules": mine } as const],
				...shared.length === 0 ? [] : [{ "kind": "group", "whose": "shared", "file": shared[0].file, "rules": shared } as const]
			];
		},
		"getTreeItem": (node) => {
			if (node.kind === "group") {
				const item = new vscode.TreeItem(node.whose === "mine" ? "Yours" : "Shared", vscode.TreeItemCollapsibleState.Expanded);

				item.description = node.file;
				item.tooltip = "Matched in this order — yours first, then the shared ones: the first rule that matches decides";
				item.contextValue = `rules.${node.whose}`;

				return item;
			}

			const { listed } = node;
			const found = placing(listed);
			const item = new vscode.TreeItem(listed.sentence, vscode.TreeItemCollapsibleState.None);

			item.iconPath = new vscode.ThemeIcon(listed.problem === undefined ? "law" : "error");
			item.description = listed.place?.line === undefined || listed.problem !== undefined ? undefined : `line ${listed.place.line}${found === "uncertain" ? "?" : ""}`;
			// (the whole sentence — a narrow sidebar cuts the label short — and what's to know about its place)
			const note = placeNote(listed, found);

			item.tooltip = note === undefined ? listed.sentence : `${listed.sentence}\n\n${note}`;
			item.contextValue = `rule.${listed.whose}${found === undefined ? "" : `.${found}`}`;
			item.command = { "command": "silo.rules.open", "title": "Open Rule", "arguments": [listed] };

			return item;
		}
	};
	const view = vscode.window.createTreeView("silo.rules", { "treeDataProvider": provider });

	/** The view's message (getChildren sets it, once the view is made). */
	function showMessage(message: string | undefined): void {
		view.message = message;
	}

	const refresh = (): void => {
		listing = undefined;
		changed.fire();
	};

	/** A rule of the tree's (whose: "mine", "shared" or "new") edited in the Rule view, its buttons by whose it is: done
	 *  as pressed — or, when it can't be (nothing selected to re-place it at), said why, and edited again as it was. */
	const open = async (whose: "mine" | "shared" | "new", rule: Rule, place: PlaceNow | null = null): Promise<void> => {
		const previous = whose === "new" ? undefined : rule;
		const lost = place !== null && place.status !== "attached" && place.status !== "moved" && place.status !== "re-placed";
		const buttons: EditButton[] = [
			{ "id": "save", "label": "Save", "className": "save", "title": whose === "shared" ? "Save it as a rule of yours, ahead of the shared one (.silo/policy/<you>.json)" : "Save it in your policy (.silo/policy/<you>.json)" },
			// Lost, or found only uncertainly: placed again at the code selected in the editor.
			...lost ? [{ "id": "replace", "label": "Re-place at selection", "className": "replace", "title": "Select the statement it belongs at in the editor, then this: the rule is placed there", "always": true }] : [],
			...whose === "mine" ? [{ "id": "remove", "label": "Remove", "className": "remove", "title": "Take it out of your policy", "always": true }] : [],
			{ "id": "cancel", "label": "Cancel", "className": "cancel", "title": "Close it, changing nothing", "always": true }
		];
		let shown = rule;

		for (;;) {
			const answer = await vscode.commands.executeCommand<EditAnswer>("editor.rules.edit", { "id": "silo.rules.open", "rule": shown, "judge": { "kind": "rule" }, "variables": variablesOf(shown).map((name) => ({ "name": name, "kind": "" })), "buttons": buttons });

			try {
				switch (answer?.button) {
					case "save":
						await setRule(previous, answer.rule);
						break;
					case "replace":
						await setRule(previous, withPlace(answer.rule, await selected()));
						break;
					case "remove":
						await setRule(rule, undefined);
						break;
					// no default
				}

				// (the tree redraws as the file changes; this is sooner)
				refresh();

				return;
			} catch (error) {
				void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
				shown = answer?.rule ?? shown;
			}
		}
	};

	const watcher = vscode.workspace.createFileSystemWatcher(POLICY_GLOB);

	context.subscriptions.push(
		changed,
		view,
		watcher,
		watcher.onDidChange(refresh),
		watcher.onDidCreate(refresh),
		watcher.onDidDelete(refresh),
		// (a placed rule follows its code: where it is now changes as the file's saved)
		vscode.workspace.onDidSaveTextDocument(refresh),
		vscode.commands.registerCommand("silo.rules.refresh", refresh),
		vscode.commands.registerCommand("silo.rules.list", listed),
		// (each answered as the rule opens, not when it's done with: the edit waits in the Rule view)
		vscode.commands.registerCommand("silo.rules.open", (argument: unknown) => {
			const rule = ruleOf(argument);

			if (rule !== undefined) {
				void open(rule.whose, rule.rule, rule.place ?? null);
			}
		}),
		vscode.commands.registerCommand("silo.rules.new", () => {
			void open("new", structuredClone(BLANK));
		}),
		vscode.commands.registerCommand("silo.rules.remove", async (argument: unknown) => {
			const rule = ruleOf(argument);

			if (rule?.whose === "mine") {
				await setRule(rule.rule, undefined);
			}
		}),
		vscode.commands.registerCommand("silo.rules.replace", async (argument: unknown) => {
			const rule = ruleOf(argument);

			if (rule !== undefined) {
				try {
					await setRule(rule.whose === "mine" ? rule.rule : undefined, withPlace(rule.rule, await selected()));
				} catch (error) {
					void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
				}
			}
		})
	);
}
