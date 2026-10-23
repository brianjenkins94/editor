/**
 * The Rule view (RUNNING.md, *Rules*): the rule editor (rule-editor.ts) under the Rules tree, shown while a rule's
 * being edited — and the one command that edits one (ARCHITECTURE.md, *Extension points* 5):
 *
 * - `editor.rules.edit(request)`: a rule edited here — as it starts, what it's judged against, its buttons
 *   (editor-api's `./rules`) — answered with the button pressed and the rule as it was then, or null (closed, or replaced
 *   by another edit). Whoever asks does what the button means: the Rules tree's open and New Rule (the capabilities
 *   extension's), the Margin's Rule… and Mock… at a stop, the bridge's preview prompt.
 * - `editor.rules.cancelEdit(id)`: one closed that's no longer wanted (its stop went on) — answered null.
 *
 * Core's, not the capabilities extension's: nothing native edits predicates, and a webview — an extension's own view —
 * can't paint in this workbench (the coi-serviceworker keeps every frame one origin; a webview's content needs its own).
 * So the view is real DOM, as the pane is; silo's policy (and ajv with it) loads with the first edit.
 */
import type { EditAnswer, EditRequest, PolicyModule } from "@brianjenkins94/editor-api/rules";
import type { Rule } from "@brianjenkins94/util/silo/policy";
import type * as vscodeApi from "vscode";
import { catalogOf, describeRule, startingRule, verdictOf, withVariables } from "@brianjenkins94/editor-api/rules";
import { registerCustomView, ViewContainerLocation, viewContainerRegistry } from "@brianjenkins94/monaco-vscode-api/main";
import { ruleViewStyles } from "theme/styles/rule-view";
import { ruleEditor } from "./rule-editor";
import "theme/components/button";
import "theme/components/card";

/** The edit shown: its request, and how it's answered. */
interface Pending { "request": EditRequest; "answer": (answer: EditAnswer) => void }

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, properties: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
	return Object.assign(document.createElement(tag), { "className": className, ...properties });
}

/** The edit's panel: the rule editor, what the rule as edited would do, and the buttons — `pressed` with the rule as it
 *  is then. */
function panelOf(policy: PolicyModule, request: EditRequest, pressed: (button: string, rule: Rule) => void): HTMLElement {
	const rule = startingRule(request);
	const catalog = request.variables === undefined ? catalogOf(policy) : withVariables(policy, request.variables);
	const describe = (each: Rule): string => describeRule(each, catalog);
	const panel = element("wa-card", "rule-panel");
	const body = element("div", "wa-stack wa-gap-xs");
	const status = element("div", "rule-panel-status wa-color-text-quiet");
	const choices = element("div", "wa-cluster wa-gap-xs");
	let editor: ReturnType<typeof ruleEditor> | undefined;
	const buttons = request.buttons.map((button) => {
		// (Save is the one that's the brand's: the rest are neutral)
		const each = element("wa-button", "rule-panel-choice", { "size": "s", "variant": button.className === "save" ? "brand" : "neutral", "textContent": button.label, "title": button.title });

		each.addEventListener("click", () => {
			pressed(button.id, editor?.rule() ?? rule);
		});

		return each;
	});
	const update = (): void => {
		const verdict = verdictOf(policy, editor?.rule() ?? rule, request.judge, describe);

		status.textContent = verdict.text;
		status.classList.toggle("refused", verdict.refused === true);

		for (const [index, each] of buttons.entries()) {
			each.disabled = request.buttons[index]?.always !== true && !verdict.ok;
		}
	};

	editor = ruleEditor({ "catalog": catalog, "rule": rule, "onChange": update });
	choices.append(...buttons);
	body.append(editor.element, status, choices);
	panel.append(body);
	update();

	return panel;
}

/** Register the Rule view, and `editor.rules.edit` / `.cancelEdit`. */
export function registerRuleView(vscode: typeof vscodeApi): void {
	/** The view's body, once rendered. */
	let root: HTMLElement | undefined;
	let pending: Pending | undefined;
	let panel: HTMLElement | undefined;

	const render = (): void => {
		root?.replaceChildren(panel ?? element("div", "wa-color-text-quiet", { "textContent": "Open a rule in Rules above — or make one with New Rule." }));
	};

	/** The edit's done: the view empty, and gone until a rule's edited again (the Explorer keeps its room). */
	const close = (): void => {
		pending = undefined;
		panel = undefined;
		render();
		void Promise.resolve(vscode.commands.executeCommand("editor.rule.removeView")).catch(() => undefined);
	};

	/** `request` edited here, in front — answered with its button and the rule, or null (another edit replaces it). */
	const edit = async (request: EditRequest): Promise<EditAnswer> => {
		pending?.answer(null);

		const policy = await import("@brianjenkins94/util/silo/policy");

		return new Promise<EditAnswer>((resolve) => {
			const shown: Pending = {
				"request": request,
				"answer": (answer) => {
					if (pending === shown) {
						close();
					}

					resolve(answer);
				}
			};

			pending = shown;
			panel = panelOf(policy, request, (button, rule) => {
				shown.answer({ "button": button, "rule": rule });
			});
			render();
			void Promise.resolve(vscode.commands.executeCommand("editor.rule.focus")).catch(() => undefined);
		});
	};

	registerCustomView({
		"id": "editor.rule",
		"name": "Rule",
		"location": ViewContainerLocation.Sidebar,
		"viewContainer": viewContainerRegistry.get("workbench.view.explorer"),
		"canToggleVisibility": true,
		// Shown while a rule's edited in it, gone again when it's done.
		"hideByDefault": true,
		"renderBody": (container) => {
			ruleViewStyles();
			root = element("div", "rule-view");
			container.append(root);
			render();

			return {
				"dispose": () => {
					root = undefined;
				}
			};
		}
	});

	vscode.commands.registerCommand("editor.rules.edit", edit);
	vscode.commands.registerCommand("editor.rules.cancelEdit", (id: unknown) => {
		if (pending !== undefined && pending.request.id === id) {
			pending.answer(null);
		}
	});
}
