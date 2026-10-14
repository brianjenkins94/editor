/**
 * Rules (RULES.md), the editor's half: the rule editor — live-values.ts's panel — in the Rule view under the Rules tree
 * (where the Margin's Rule… and Mock… make theirs too: editInRuleView), and the commands the tree (the capabilities
 * extension's rules-tree.ts, VS Code's own tree view) runs:
 *
 * - `silo.rules.list`: every rule in the policy files — mine (`.silo/policy/<you>.json`), then the shared contract's
 *   (`.silo/policy.json`) — each a sentence in the catalog's words, the problem that makes it match nothing, and where a
 *   placed one's place is now;
 * - `silo.rules.open` (a listed rule), `silo.rules.new`: the rule in the editor — *Save* (mine, in its place; a shared
 *   rule edited is a rule of mine, ahead of it), *Remove* (mine only: silo doesn't author the contract), *Re-place at
 *   selection* (a lost place), *Cancel*;
 * - `silo.rules.remove`, `silo.rules.replace`: a rule's inline actions.
 *
 * And a preview's capability prompt makes its rule here (`rules.make`). silo's policy (and ajv with it) loads when a rule
 * is first listed or opened, not with the workbench.
 *
 * Runs in the workbench realm (core), with the workbench's own extension API.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { EditedRule, RuleCatalog, RulePredicate } from "@brianjenkins94/monaco-vscode-api/main";
import type * as vscodeApi from "vscode";
import type { PanelButton, PolicyModule, Verdict } from "./live-values";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { describeRule, registerCustomView, ViewContainerLocation, viewContainerRegistry } from "@brianjenkins94/monaco-vscode-api/main";
import { annotations } from "@brianjenkins94/run-contract/annotations";
import { callRule, callVerdict, decisionOf, ensureStyled, rulePanel, variablesOf, withVariables } from "./live-values";
import css from "./rules-view.css?raw";

/** Where a placed rule's place is now: its line, and how it was found — or lost. */
interface Place { "status": string; "line"?: number; "why"?: string }

/** A policy file's rules, with its workspace-relative path, and where each placed rule's place is now (null: none). */
interface PolicyFile { "file": string; "rules": EditedRule[]; "places"?: (Place | null)[] }

/** A rule as the Rules tree lists it (`silo.rules.list`, and debug-mcp's `rules`). */
interface Listed { "whose": "mine" | "shared"; "file": string; "sentence": string; "problem"?: string; "place"?: Place; "rule": EditedRule }

/** A new rule, as it starts: one row to fill in, and allow. */
const BLANK: EditedRule = { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "" }] }, "then": [{ "action_id": "allow" }] };

/** `rule` with its place (each `at is …`) changed to `place`. */
function replacePlace(rule: EditedRule, place: unknown): EditedRule {
	const walk = (predicate: RulePredicate): RulePredicate => {
		if ("predicates" in predicate) {
			return { ...predicate, "predicates": predicate.predicates.map(walk) };
		}

		return predicate.target_id === "at" && predicate.operator_id === "is" ? { ...predicate, "argument": place } : predicate;
	};

	return { ...rule, "when": walk(rule.when) as EditedRule["when"] };
}

/** The Rule view's editor, once registered: show a panel in it, close it, and the one shown. */
let host: { "show": (panel: HTMLElement) => void; "close": () => void; "shown": () => HTMLElement | undefined } | undefined;

/** Edit in the Rule view: `panel` (a rule editor, rulePanel's) shown there, in front — answered with how to close it,
 *  which does only while it's still the one shown. The Margin's Rule… and Mock… make their rules here, not inline
 *  (EXTENSION-POINTS.md, 4: a pane view's items are data). */
export function editInRuleView(panel: HTMLElement): () => void {
	host?.show(panel);

	return () => {
		if (host?.shown() === panel) {
			host.close();
		}
	};
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, properties: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
	return Object.assign(document.createElement(tag), { "className": className, ...properties });
}

/** Register the rule editor (the Rule view) and the Rules tree's commands. */
export function registerRulesView(hub: Hub, vscode: typeof vscodeApi): void {
	const rpc = createRpcClient(hub);
	const list = async (): Promise<{ "mine": PolicyFile; "shared": PolicyFile } | null> => rpc.request("rules.list", undefined, { "timeoutMs": 10_000 }) as Promise<{ "mine": PolicyFile; "shared": PolicyFile } | null>;
	const set = async (previous: EditedRule | undefined, rule: EditedRule | undefined): Promise<unknown> => {
		const answer = await rpc.request("rules.set", { ...previous === undefined ? {} : { "previous": previous }, ...rule === undefined ? {} : { "rule": rule } }, { "timeoutMs": 10_000 });

		// (the tree redraws as the file changes; this is sooner)
		void Promise.resolve(vscode.commands.executeCommand("silo.rules.refresh")).catch(() => undefined);

		return answer;
	};

	/** The Rule view's body, once rendered. */
	let root: HTMLElement | undefined;
	let policy: PolicyModule | undefined;
	/** The rule open in the editor, and its panel, kept as it is across redraws. */
	let editing: { "panel": HTMLElement } | undefined;

	const loadPolicy = async (): Promise<PolicyModule> => {
		if (policy !== undefined) {
			return policy;
		}

		return import("@brianjenkins94/util/silo/policy").then((loaded) => {
			policy = loaded;

			return loaded;
		});
	};

	const render = (): void => {
		root?.replaceChildren(editing?.panel ?? element("div", "rules-view-empty", { "textContent": "Open a rule in Rules above — or make one with New Rule." }));
	};

	/** The editor shown, in front. */
	const show = (panel: HTMLElement): void => {
		editing = { "panel": panel };
		render();
		void Promise.resolve(vscode.commands.executeCommand("silo.rule.focus")).catch(() => undefined);
	};

	// (and the view goes, until a rule's opened again: the Explorer keeps its room)
	const close = (): void => {
		editing = undefined;
		render();
		void Promise.resolve(vscode.commands.executeCommand("silo.rule.removeView")).catch(() => undefined);
	};

	host = { "show": show, "close": close, "shown": () => editing?.panel };

	/** silo's catalog, with the variables `rule` names. */
	const catalogFor = (rule: EditedRule): RuleCatalog => withVariables(policy, variablesOf(rule).map((name) => ({ "name": name, "kind": "" })));

	/** The span reference of the code selected in the editor, for a rule whose place is lost — or why there isn't one. */
	const selected = async (): Promise<unknown> => {
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
	};

	/** `rule` (whose: "mine", "shared" or "new") in the editor, its buttons by whose it is. */
	const open = (whose: "mine" | "shared" | "new", rule: EditedRule, place: Place | null = null): void => {
		const catalog = catalogFor(rule);
		const judge = (edited: EditedRule): Verdict => {
			const problem = policy.problemOf(edited);

			return problem === undefined ? { "text": describeRule(edited, catalog), "ok": true } : { "text": problem, "ok": false, "refused": true };
		};

		const previous = whose === "new" ? undefined : rule;
		const save = async (edited: EditedRule): Promise<void> => {
			await set(previous, edited);
			close();
		};

		const replaceAtSelection = async (edited: EditedRule): Promise<void> => {
			await set(previous, replacePlace(edited, await selected()));
			close();
		};

		const remove = async (): Promise<void> => {
			await set(rule, undefined);
			close();
		};

		const cancel = (): Promise<void> => {
			close();

			return Promise.resolve();
		};

		const buttons: PanelButton[] = [
			{ "label": "Save", "className": "save", "title": whose === "shared" ? "Save it as a rule of yours, ahead of the shared one (.silo/policy/<you>.json)" : "Save it in your policy (.silo/policy/<you>.json)", "act": save },
			// Lost, or found only uncertainly: placed again at the code selected in the editor.
			...place !== null && place.status !== "attached" && place.status !== "moved" && place.status !== "re-placed" ? [{ "label": "Re-place at selection", "className": "replace", "title": "Select the statement it belongs at in the editor, then this: the rule is placed there", "act": replaceAtSelection, "always": true }] : [],
			...whose === "mine" ? [{ "label": "Remove", "className": "remove", "title": "Take it out of your policy", "act": remove, "always": true }] : [],
			{ "label": "Cancel", "className": "cancel", "title": "Close it, changing nothing", "act": cancel, "always": true }
		];

		show(rulePanel(policy, rule, judge, buttons, catalog));
	};

	/** Every rule, as the tree lists it: mine, then the shared contract's — or null without a folder. */
	const listed = async (): Promise<Listed[] | null> => {
		const files = await list().catch(() => null);

		if (files === null) {
			return null;
		}

		await loadPolicy();

		const each = (whose: "mine" | "shared", { file, rules, places }: PolicyFile): Listed[] => rules.map((rule, index) => {
			const place = places?.[index] ?? null;
			// A rule whose place in the code is lost can't apply: as broken as one that can't be matched. Nor can one whose
			// file can't be parsed as it is — though its place isn't lost, and it applies again once the file parses.
			const problem = policy.problemOf(rule) ?? (place?.status === "orphaned" ? "Its place in the code is lost — the statement it was at is gone or changed past recognizing" : undefined) ?? (place?.status === "unparsable" ? `Where it applies can't be told: its file can't be parsed as it is (${place.why ?? "BABLR can't parse it"})` : undefined);

			return { "whose": whose, "file": file, "sentence": problem === undefined ? describeRule(rule, catalogFor(rule)) : `${problem} — it matches nothing`, ...problem === undefined ? {} : { "problem": problem }, ...place === null ? {} : { "place": place }, "rule": rule };
		});

		return [...each("mine", files.mine), ...each("shared", files.shared)];
	};

	/** A command's rule: the tree's listed rule — or its node, from an inline action. */
	const ruleOf = (argument: unknown): Listed | undefined => {
		const value = argument as { "listed"?: Listed } & Partial<Listed> | undefined;

		return value?.listed ?? (value?.rule === undefined ? undefined : value as Listed);
	};

	registerCustomView({
		"id": "silo.rule",
		"name": "Rule",
		"location": ViewContainerLocation.Sidebar,
		"viewContainer": viewContainerRegistry.get("workbench.view.explorer"),
		"canToggleVisibility": true,
		// Shown while a rule's open in it (`show`), gone again when it's closed.
		"hideByDefault": true,
		"renderBody": (container) => {
			ensureStyled();
			document.head.append(Object.assign(document.createElement("style"), { "textContent": css }));
			root = element("div", "rules-view");
			container.append(root);
			render();

			const dispose = (): void => {
				root = undefined;
			};

			return { "dispose": dispose };
		}
	});

	vscode.commands.registerCommand("silo.rules.list", listed);
	vscode.commands.registerCommand("silo.rules.open", async (argument: unknown) => {
		const rule = ruleOf(argument);

		if (rule !== undefined) {
			await loadPolicy();
			open(rule.whose, rule.rule, rule.place ?? null);
		}
	});
	vscode.commands.registerCommand("silo.rules.new", async () => {
		await loadPolicy();
		open("new", structuredClone(BLANK));
	});
	vscode.commands.registerCommand("silo.rules.remove", async (argument: unknown) => {
		const rule = ruleOf(argument);

		if (rule?.whose === "mine") {
			await set(rule.rule, undefined);
		}
	});
	vscode.commands.registerCommand("silo.rules.replace", async (argument: unknown) => {
		const rule = ruleOf(argument);

		if (rule !== undefined) {
			try {
				await set(rule.whose === "mine" ? rule.rule : undefined, replacePlace(rule.rule, await selected()));
			} catch (error) {
				void vscode.window.showErrorMessage(error instanceof Error ? error.message : String(error));
			}
		}
	});

	// Every rule as the tree lists it, as data (the `rules_list` tool).
	serve(hub, "rules.state", async () => ({ "rules": await listed() ?? [] }));

	// A preview's capability prompt (decide.ts): its Rule… makes the rule here — a new one, prefilled with the call (and the
	// package making it, a package's) —
	// and the call waits on it: Just this once (decided by it, not kept), Save as rule (kept, and decided by it), or
	// Cancel (back to the prompt's choices). Answers the decision, or null.
	serve(hub, "rules.make", async (args) => {
		const { capability, resource, "package": pkg } = (args ?? {}) as { "capability"?: string; "resource"?: string; "package"?: string };

		if (typeof capability !== "string") {
			return null;
		}

		await loadPolicy();

		const subject = { "capability": capability, "resource": resource ?? "", ...typeof pkg === "string" ? { "package": pkg } : {} };

		return new Promise<string | null>((resolve) => {
			const done = (decision: string | null): void => {
				resolve(decision);
				close();
			};

			const once = (rule: EditedRule): Promise<void> => {
				done(decisionOf(rule) ?? null);

				return Promise.resolve();
			};

			const saveAsRule = async (rule: EditedRule): Promise<void> => {
				await set(undefined, rule);
				done(decisionOf(rule) ?? null);
			};

			const cancel = (): Promise<void> => {
				done(null);

				return Promise.resolve();
			};

			show(rulePanel(policy, callRule(capability, resource, typeof pkg === "string" ? pkg : undefined), (rule) => callVerdict(policy, rule, subject), [
				{ "label": "Just this once", "className": "once", "title": "Decide this call as the rule does, and ask again next time", "act": once },
				{ "label": "Save as rule", "className": "save", "title": "Keep it in your policy (.silo/policy/<you>.json), and decide this call by it", "act": saveAsRule },
				{ "label": "Cancel", "className": "cancel", "title": "Back to the preview's question", "act": cancel, "always": true }
			]));
		});
	});
}
