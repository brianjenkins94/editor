/**
 * The Rules view (RULES.md): every rule in the policy files, in the Explorer beside Capability calls — mine first
 * (`.silo/<you>.policy.json`), then the shared contract's (`.silo/policy.json`) — each a sentence in the catalog's words,
 * in the order they're matched: the first that matches decides. A click opens it in the rule editor, the margin's own
 * panel (live-values.ts): *Save* (mine, in its place; a shared rule edited is a rule of mine, ahead of it), *Remove*
 * (mine only: silo doesn't author the contract), *Cancel*. *New Rule*, in the view's title, starts one. A rule that
 * can't be matched says why.
 *
 * Collapsed until it's opened: silo's policy (and ajv with it) loads when the view first renders, not with the
 * workbench. It redraws as the policy files change — by a rule editor anywhere, or by hand.
 *
 * Runs in the workbench realm (core).
 */
import type { Hub } from "@brianjenkins94/hub";
import type { EditedRule } from "@brianjenkins94/monaco-vscode-api/main";
import type { PanelButton, PolicyModule, Verdict } from "./live-values";
import { createRpcClient } from "@brianjenkins94/hub";
import { describeRule, registerCustomView, viewContainerRegistry, ViewContainerLocation } from "@brianjenkins94/monaco-vscode-api/main";
import { catalogOf, ensureStyled, onRulesChanged, rulePanel } from "./live-values";
import css from "./rules-view.css?raw";

/** A policy file's rules, with its workspace-relative path. */
interface PolicyFile { "file": string; "rules": EditedRule[] }

/** A new rule, as it starts: one row to fill in, and allow. */
const BLANK: EditedRule = { "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "" }] }, "then": [{ "action_id": "allow" }] };

/** What a rule is, whenever it was decided: the key its open editor is kept by. */
const keyOf = (whose: string, rule: EditedRule): string => `${whose}:${JSON.stringify({ "when": rule.when, "then": rule.then })}`;

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, properties: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
	return Object.assign(document.createElement(tag), { "className": className, ...properties });
}

/** Register the Rules view; it lists and edits the rules once it's opened. */
export function registerRulesView(hub: Hub): void {
	const rpc = createRpcClient(hub);
	const list = async (): Promise<{ "mine": PolicyFile; "shared": PolicyFile } | null> => rpc.request("rules.list", undefined, { "timeoutMs": 10_000 }) as Promise<{ "mine": PolicyFile; "shared": PolicyFile } | null>;
	const set = async (previous: EditedRule | undefined, rule: EditedRule | undefined): Promise<unknown> => rpc.request("rules.set", { ...previous === undefined ? {} : { "previous": previous }, ...rule === undefined ? {} : { "rule": rule } }, { "timeoutMs": 10_000 });
	/** The view's body, once rendered. */
	let root: HTMLElement | undefined;
	let policy: PolicyModule | undefined;
	/** The rule open in the editor — by `keyOf`, or "new" — and its panel, kept as it is across redraws. */
	let editing: { "key": string; "panel": HTMLElement } | undefined;
	let rendering = 0;

	const close = (): void => {
		editing = undefined;
		void render();
	};

	/** The editor for `rule` (whose: "mine", "shared" or "new"), its buttons by whose it is. */
	const open = (key: string, whose: string, rule: EditedRule): void => {
		const judge = (edited: EditedRule): Verdict => {
			const problem = policy!.problemOf(edited);

			return problem === undefined ? { "text": describeRule(edited, catalogOf(policy!)), "ok": true } : { "text": problem, "ok": false, "refused": true };
		};
		const previous = whose === "new" ? undefined : rule;
		const buttons: PanelButton[] = [
			{ "label": "Save", "className": "save", "title": whose === "shared" ? "Save it as a rule of yours, ahead of the shared one (.silo/<you>.policy.json)" : "Save it in your policy (.silo/<you>.policy.json)", "act": async (edited) => { await set(previous, edited); close(); } },
			...whose === "mine" ? [{ "label": "Remove", "className": "remove", "title": "Take it out of your policy", "act": async () => { await set(rule, undefined); close(); }, "always": true }] : [],
			{ "label": "Cancel", "className": "cancel", "title": "Close it, changing nothing", "act": async () => { close(); }, "always": true }
		];

		editing = { "key": key, "panel": rulePanel(policy!, rule, judge, buttons) };
		void render();
	};

	/** One rule's line: its sentence (or why it can't be matched), and the editor under it when it's open. */
	const ruleLine = (whose: "mine" | "shared", rule: EditedRule): HTMLElement[] => {
		const key = keyOf(whose, rule);
		const problem = policy!.problemOf(rule);
		const line = element("div", `rules-view-rule${problem === undefined ? "" : " broken"}${editing?.key === key ? " open" : ""}`, { "tabIndex": 0, "title": rule.added === undefined ? "" : `First decided ${new Date(rule.added).toLocaleString()}` });

		line.append(
			element("span", `codicon codicon-${problem === undefined ? "law" : "error"}`),
			element("span", "rules-view-sentence", { "textContent": problem === undefined ? describeRule(rule, catalogOf(policy!)) : `${problem} — it matches nothing` })
		);
		line.addEventListener("click", () => {
			if (editing?.key === key) {
				close();
			} else {
				open(key, whose, rule);
			}
		});
		line.addEventListener("keydown", (event) => {
			if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				line.click();
			}
		});

		return editing?.key === key ? [line, editing.panel] : [line];
	};

	const section = (title: string, whose: "mine" | "shared", { file, rules }: PolicyFile, empty: string): HTMLElement => {
		const block = element("div", "rules-view-section");
		const head = element("div", "rules-view-head", { "title": "Matched in this order — yours first, then the shared ones: the first rule that matches decides" });

		head.append(element("span", "rules-view-title", { "textContent": title }), element("span", "rules-view-file", { "textContent": file }));
		// A new rule is made here, first: where it's saved.
		block.append(head, ...whose === "mine" && editing?.key === "new" ? [editing.panel] : [], ...rules.length === 0 && editing?.key !== "new" ? [element("div", "rules-view-empty", { "textContent": empty })] : rules.flatMap((rule) => ruleLine(whose, rule)));

		return block;
	};

	async function render(): Promise<void> {
		if (root === undefined) {
			return;
		}

		rendering += 1;

		const token = rendering;

		policy ??= await import("@brianjenkins94/util/silo/policy");

		const listing = await list().catch(() => null);

		if (token !== rendering) {
			return; // a newer render is drawing
		}

		if (listing === null) {
			root.replaceChildren(element("div", "rules-view-empty", { "textContent": "Open a folder to keep rules: they live in its .silo/ folder." }));

			return;
		}

		root.replaceChildren(
			section("Yours", "mine", listing.mine, "None yet — make one with New Rule above, Rule… at a capability stop, or Mock… on process.argv's row."),
			...listing.shared.rules.length === 0 ? [] : [section("Shared", "shared", listing.shared, "")]
		);
	}

	registerCustomView({
		"id": "silo.rules",
		"name": "Rules",
		"location": ViewContainerLocation.Sidebar,
		"viewContainer": viewContainerRegistry.get("workbench.view.explorer"),
		"canToggleVisibility": true,
		"collapsed": true,
		"renderBody": (container) => {
			ensureStyled();
			document.head.append(Object.assign(document.createElement("style"), { "textContent": css }));
			root = element("div", "rules-view");
			container.append(root);
			void render();

			return { "dispose": () => { root = undefined; } };
		},
		"actions": [{
			"id": "silo.rules.new",
			"title": "New Rule",
			"icon": "add",
			"run": async () => {
				policy ??= await import("@brianjenkins94/util/silo/policy");
				open("new", "new", structuredClone(BLANK));
			}
		}]
	});

	// The policy files changed — by a rule editor anywhere, or by hand: redraw.
	onRulesChanged(() => { void render(); });
}
