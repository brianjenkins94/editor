/**
 * A rule editor (packages/editor/RULES.md): macOS's predicate editor — Finder's smart folders, Mail's rules — for a rule
 * `{ when, then }`. WHEN is rows of *target / operator / argument*, combined *all*, *any* or *none*, nestable; THEN is a
 * list of actions. Each row has − and +; ⌥-click on + adds a group. The model is ui-predicate's (kept JSON-compatible):
 * a compound `{ logicalType_id, predicates }` of comparisons `{ target_id, operator_id, argument }`.
 *
 * Nothing here knows what the targets are: the consumer passes the catalog — the targets, which operators each type of
 * target offers, the actions, and each argument's JSON Schema — and every argument's input is drawn from its schema: a
 * string is a text box (its `examples` offered), an `enum` a select, an array a list with − and +, a number a number,
 * a boolean a checkbox, anything else a JSON literal. One editor for every seam, rather than a form per feature.
 *
 * Vanilla DOM: Web Awesome's controls and layout utilities, in VS Code's own look (theme/vscode maps its colors onto
 * Web Awesome's tokens; its icons drawn here, as strokes). Core's,
 * in the Rule view (rule-view.ts); a rule as a sentence and what it would do are editor-api's (`./rules`), which the
 * capabilities extension's Rules tree shares.
 */
import type WaButton from "@awesome.me/webawesome/dist/components/button/button.js";
import type WaInput from "@awesome.me/webawesome/dist/components/input/input.js";
import type { RuleCatalog } from "@brianjenkins94/editor-api/rules";
import type { Action, Comparison, Compound, Predicate, Rule, Schema } from "@brianjenkins94/util/silo/policy";
import { joinCommandLine, sayPlace } from "@brianjenkins94/editor-api/rules";
import css from "theme/exceptions/rule-editor.css?raw";
import "@awesome.me/webawesome/dist/components/button/button.js";
import "@awesome.me/webawesome/dist/components/checkbox/checkbox.js";
import "@awesome.me/webawesome/dist/components/dropdown/dropdown.js";
import "@awesome.me/webawesome/dist/components/dropdown-item/dropdown-item.js";
import "@awesome.me/webawesome/dist/components/input/input.js";
import "@awesome.me/webawesome/dist/components/option/option.js";
import "@awesome.me/webawesome/dist/components/select/select.js";

export interface RuleEditorOptions {
	"catalog": RuleCatalog;
	"rule": Rule;
	/** The rule as edited, after every change. */
	"onChange"?: (rule: Rule) => void;
}

export interface RuleEditor {
	"element": HTMLElement;
	/** The rule as it is now. */
	"rule": () => Rule;
}

const LOGICAL: Record<Compound["logicalType_id"], string> = { "all": "All", "any": "Any", "none": "None" };

const isCompound = (predicate: Predicate): predicate is Compound => "predicates" in predicate;

let styled = false;

/** A value a schema's input starts with. */
function initial(schema: Schema | undefined): unknown {
	if (typeof schema !== "object") {
		return "";
	}

	if (Array.isArray(schema["enum"])) {
		return (schema["enum"] as unknown[])[0];
	}

	switch (Array.isArray(schema["type"]) ? (schema["type"] as string[])[0] : schema["type"]) {
		case "array":
			return Array.from({ "length": typeof schema["minItems"] === "number" ? schema["minItems"] : 0 }, () => initial(schema["items"] as Schema | undefined));
		case "number":
		case "integer":
			return 0;
		case "boolean":
			return false;
		case "object":
			return {};
		default:
			return "";
	}
}

function element<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, properties: Partial<HTMLElementTagNameMap[K]> = {}): HTMLElementTagNameMap[K] {
	return Object.assign(document.createElement(tag), { "className": className, ...properties });
}

/** A select of `options` ([value, label]), `value` chosen. */
function select(className: string, options: [string, string][], value: string, changed: (value: string) => void): HTMLElement {
	const each = element("wa-select", `rule-editor-select ${className}`, { "size": "s" });

	each.append(...options.map(([option, label]) => element("wa-option", "", { "value": option, "textContent": label })));
	each.value = value;
	each.addEventListener("change", () => {
		changed(String(each.value));
	});

	return each;
}

/** A text input, sized for a rule's row. */
function textInput(className: string, properties: Partial<WaInput> = {}): WaInput {
	return element("wa-input", `rule-editor-argument ${className}`, { "size": "s", "spellcheck": false, ...properties });
}

/** The icons the editor draws (codicon's shapes, as strokes in the text's color). */
const ICONS = { "add": "M8 3v10M3 8h10", "remove": "M3 8h10", "close": "M4 4l8 8M12 4l-8 8", "chevron-down": "M4 6l4 4 4-4" };

/** An icon: a 16px drawing in the text's color (`codicon` keeps the class the stylesheet places it by). */
function icon(name: keyof typeof ICONS): SVGSVGElement {
	const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
	const path = document.createElementNS("http://www.w3.org/2000/svg", "path");

	svg.setAttribute("class", `codicon codicon-${name}`);
	svg.setAttribute("viewBox", "0 0 16 16");
	svg.setAttribute("width", "16");
	svg.setAttribute("height", "16");
	path.setAttribute("d", ICONS[name]);
	path.setAttribute("fill", "none");
	path.setAttribute("stroke", "currentColor");
	path.setAttribute("stroke-width", "1.3");
	path.setAttribute("stroke-linecap", "round");
	path.setAttribute("stroke-linejoin", "round");
	svg.append(path);

	return svg;
}

/** An icon button. */
function iconButton(name: keyof typeof ICONS, title: string, clicked: (event: MouseEvent) => void): WaButton {
	const each = element("wa-button", "rule-editor-button", { "title": title, "size": "s", "appearance": "plain" });

	each.append(icon(name));
	each.addEventListener("click", clicked);

	return each;
}

/** A command line's arguments: split at spaces, but not inside quotes ("…" or '…'). */
function splitCommandLine(text: string): string[] {
	return [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/gu)].map(([, double, single, bare]) => (double !== undefined ? double.replace(/\\(.)/gu, "$1") : single ?? bare ?? ""));
}

/** An input for a list (`type: "array"`): a command line's arguments in one box, else an input per item with − and +. */
function arrayInput(object: Record<string, unknown>, value: unknown, changed: (value: unknown) => void): HTMLElement {
	// Arguments, as you'd type them after a command (process.argv's): one box, not a box per argument.
	if (object["format"] === "command-line") {
		const line = textInput("command-line", { "value": joinCommandLine(Array.isArray(value) ? value : []), "placeholder": "arguments, as a command line", "title": "As you'd type them after `node file.js`: separated by spaces, quoted to keep one together" });

		line.addEventListener("input", () => {
			changed(splitCommandLine(line.value ?? ""));
		});

		return line;
	}

	const items = Array.isArray(value) ? [...value as unknown[]] : [];
	const itemSchema = object["items"] as Schema | undefined;
	// A list of lists (process.argv's runs): each on a line of its own.
	const nested = typeof itemSchema === "object" && itemSchema["type"] === "array";
	const list = element("span", nested ? "rule-editor-list nested wa-stack wa-gap-3xs" : "rule-editor-list wa-cluster wa-gap-3xs");
	const draw = (): void => {
		list.replaceChildren();

		for (const [index, item] of items.entries()) {
			const entry = element("span", `rule-editor-list-item wa-cluster wa-gap-3xs${nested ? " wa-flex-nowrap" : ""}`);

			entry.append(schemaInput(itemSchema, item, (next) => {
				items[index] = next;
				changed([...items]);
			}), iconButton("close", "Remove it", () => {
				items.splice(index, 1);
				changed([...items]);
				draw();
			}));
			list.append(entry);
		}

		const add = iconButton("add", "Another", () => {
			items.push(initial(itemSchema));
			changed([...items]);
			draw();
		});

		// Under a list of lists, not as wide as it.
		add.classList.toggle("wa-align-self-start", nested);
		list.append(add);
	};

	draw();

	return list;
}

/** An input for a string: a text box, offering its `examples` as it's typed in. */
function stringInput(object: Record<string, unknown>, input: WaInput, value: unknown, changed: (value: unknown) => void): HTMLElement {
	input.value = typeof value === "string" ? value : "";
	input.placeholder = object["format"] === "glob" ? "a glob: /workspace/**" : "";
	input.title = object["format"] === "glob" ? "* is anything but /, ** anything at all, ? one character" : "";

	input.addEventListener("input", () => {
		changed(input.value);
	});

	if (!Array.isArray(object["examples"])) {
		return input;
	}

	// Its examples, a menu at its end: one chosen is typed in.
	const examples = element("wa-dropdown", "", { "size": "s" });
	const trigger = iconButton("chevron-down", "Examples", () => undefined);

	trigger.slot = "trigger";
	examples.append(trigger, ...(object["examples"] as unknown[]).map((example) => {
		const text = typeof example === "string" ? example : JSON.stringify(example);

		return element("wa-dropdown-item", "", { "value": text, "textContent": text });
	}));
	examples.addEventListener("wa-select", (event) => {
		input.value = (event as CustomEvent<{ "item": { "value": string } }>).detail.item.value;
		changed(input.value);
	});
	examples.slot = "end";
	input.append(examples);

	return input;
}

/** An input for a value of `schema`, showing `value`; `changed` with each valid edit. */
export function schemaInput(schema: Schema | undefined, value: unknown, changed: (value: unknown) => void): HTMLElement {
	const object = typeof schema === "object" ? schema : {};
	const type = Array.isArray(object["type"]) ? undefined : object["type"];

	if (Array.isArray(object["enum"])) {
		const values = object["enum"] as unknown[];

		return select("rule-editor-enum", values.map((each, index) => [String(index), typeof each === "string" ? each : JSON.stringify(each)]), String(Math.max(0, values.findIndex((each) => JSON.stringify(each) === JSON.stringify(value)))), (index) => {
			changed(values[Number(index)]);
		});
	}

	// A place in the code: chosen where it is (from the line, in the margin), not typed — shown, not edited.
	if (object["format"] === "span") {
		return element("span", "rule-editor-place wa-text-truncate", { "textContent": sayPlace(value), "title": "A statement, followed through edits: where it is, not its line number" });
	}

	if (type === "array") {
		return arrayInput(object, value, changed);
	}

	if (type === "boolean") {
		const box = element("wa-checkbox", "rule-editor-check", { "size": "s", "checked": value === true });

		box.addEventListener("change", () => {
			changed(box.checked);
		});

		return box;
	}

	const input = textInput("");

	if (type === "string") {
		return stringInput(object, input, value, changed);
	}

	if (type === "number" || type === "integer") {
		input.type = "number";
		input.value = String(typeof value === "number" ? value : 0);
		input.addEventListener("input", () => {
			if (input.value !== "" && input.value !== null) {
				changed(Number(input.value));
			}
		});

		return input;
	}

	// Anything else: a JSON literal (a bare word is taken as a string).
	input.value = typeof value === "string" && type === undefined && typeof schema !== "object" ? value : JSON.stringify(value ?? "");
	input.placeholder = "a literal: 'text', 4, true, [1, 2], { \"a\": 1 }";
	input.addEventListener("input", () => {
		try {
			changed(JSON.parse(input.value ?? ""));
			input.setCustomValidity("");
		} catch {
			if (typeof schema === "object") {
				input.setCustomValidity("Not a literal: 'text', 4, true, [1, 2], { \"a\": 1 }");
			} else {
				changed(input.value);
			}
		}
	});

	return input;
}

/** Edit a rule. */
export function ruleEditor({ catalog, rule, onChange }: RuleEditorOptions): RuleEditor {
	if (!styled) {
		styled = true;
		document.head.append(Object.assign(document.createElement("style"), { "textContent": css }));
	}

	const edited: Rule = structuredClone(rule);
	const root = element("div", "rule-editor wa-stack wa-gap-xs");
	const firstTarget = Object.keys(catalog.targets)[0] ?? "";
	const operatorsOf = (targetId: string): string[] => catalog.types[catalog.targets[targetId]?.type_id ?? ""] ?? Object.keys(catalog.operators);
	const changed = (): void => {
		onChange?.(structuredClone(edited));
	};

	const comparison = (targetId = firstTarget): Comparison => {
		const operatorId = operatorsOf(targetId)[0] ?? "";

		return { "target_id": targetId, "operator_id": operatorId, "argument": initial(catalog.argumentSchema(targetId, operatorId)) };
	};

	/** A row's − and +: remove it from `siblings` (not the last of the top level), add a row after it, or with ⌥ a group. */
	const tools = (siblings: Predicate[], index: number, removable: boolean): HTMLElement => {
		const span = element("span", "rule-editor-tools wa-cluster wa-gap-0 wa-flex-nowrap");
		const remove = iconButton("remove", "Remove this condition", () => {
			siblings.splice(index, 1);
			render();
			changed();
		});

		remove.disabled = !removable;
		span.append(remove, iconButton("add", "Add a condition — ⌥-click: a group of them", (event) => {
			const at = siblings[index];
			const row = comparison(at !== undefined && !isCompound(at) ? at.target_id : firstTarget);

			siblings.splice(index + 1, 0, event.altKey ? { "logicalType_id": "any", "predicates": [row] } : row);
			render();
			changed();
		}));

		return span;
	};

	const renderComparison = (row: Comparison, siblings: Predicate[], index: number, removable: boolean): HTMLElement => {
		const line = element("div", "rule-editor-row wa-cluster wa-gap-2xs");
		const targets: [string, string][] = Object.entries(catalog.targets).map(([id, { label }]) => [id, label]);

		// A target the catalog doesn't have (written by hand) is kept, as itself.
		if (catalog.targets[row.target_id] === undefined) {
			targets.push([row.target_id, row.target_id]);
		}

		const target = select("rule-editor-target", targets, row.target_id, (targetId) => {
			Object.assign(row, comparison(targetId));
			render();
			changed();
		});

		target.title = catalog.targets[row.target_id]?.description ?? "";

		const operator = select("rule-editor-operator", operatorsOf(row.target_id).map((id) => [id, catalog.operators[id]?.label ?? id]), row.operator_id, (operatorId) => {
			const before = catalog.argumentSchema(row.target_id, row.operator_id);
			const after = catalog.argumentSchema(row.target_id, operatorId);

			row["operator_id"] = operatorId;

			// The argument stays when the input does (is → is not); otherwise it starts over.
			if (JSON.stringify(before) !== JSON.stringify(after)) {
				row.argument = initial(after);
			}

			render();
			changed();
		});
		const schema = catalog.argumentSchema(row.target_id, row.operator_id);

		line.append(target, operator);

		if (schema !== undefined) {
			line.append(schemaInput(schema, row.argument, (argument) => {
				row.argument = argument;
				changed();
			}));
		}

		line.append(tools(siblings, index, removable));

		return line;
	};

	const renderCompound = (compound: Compound, siblings: Predicate[] | undefined, index: number): HTMLElement => {
		const group = element("div", `rule-editor-group${siblings === undefined ? " top" : ""}`);
		const head = element("div", "rule-editor-row rule-editor-head wa-cluster wa-gap-2xs");
		const rows = element("div", "rule-editor-rows wa-stack wa-gap-3xs");
		const lead = siblings === undefined ? "When" : "";

		head.append(
			...lead === "" ? [] : [element("span", "wa-color-text-quiet", { "textContent": lead })],
			select("rule-editor-logical", Object.entries(LOGICAL), compound.logicalType_id, (logical) => {
				compound["logicalType_id"] = logical as Compound["logicalType_id"];
				changed();
			}),
			element("span", "wa-color-text-quiet", { "textContent": "of these are true" })
		);

		if (siblings !== undefined) {
			head.append(tools(siblings, index, true));
		}

		for (const [each, predicate] of compound.predicates.entries()) {
			// The top level keeps one row; a group, removed by its own −, can lose all of its.
			const removable = siblings !== undefined || compound.predicates.length > 1;

			rows.append(isCompound(predicate) ? renderCompound(predicate, compound.predicates, each) : renderComparison(predicate, compound.predicates, each, removable));
		}

		if (compound.predicates.length === 0) {
			rows.append(iconButton("add", "Add a condition", () => {
				compound.predicates.push(comparison());
				render();
				changed();
			}));
		}

		group.append(head, rows);

		return group;
	};

	/** An action as it starts: its first target, if it takes one, and an argument of that target's. */
	const actionOf = (actionId: string): Action => {
		const targets = catalog.actions[actionId]?.targets;
		const targetId = targets?.[0];
		const schema = catalog.actionSchema(actionId, targetId);

		return { "action_id": actionId, ...targetId === undefined ? {} : { "target_id": targetId }, ...schema === undefined ? {} : { "argument": initial(schema) } };
	};

	// An action whose targets are all named per use (set's variables) is offered only where its host names some.
	const offered = Object.entries(catalog.actions).filter(([, { targets }]) => targets === undefined || targets.length > 0);

	const renderActions = (): HTMLElement => {
		const block = element("div", "rule-editor-then wa-stack wa-gap-3xs");

		for (const [index, action] of edited.then.entries()) {
			const line = element("div", "rule-editor-row wa-cluster wa-gap-2xs");
			const tools = element("span", "rule-editor-tools wa-cluster wa-gap-0 wa-flex-nowrap");
			const remove = iconButton("remove", "Remove this action", () => {
				edited.then.splice(index, 1);
				render();
				changed();
			});
			const targets = catalog.actions[action.action_id]?.targets;
			const schema = catalog.actionSchema(action.action_id, action.target_id);
			const actions: [string, string][] = offered.map(([id, { label }]) => [id, label]);

			if (!actions.some(([id]) => id === action.action_id)) {
				actions.push([action.action_id, catalog.actions[action.action_id]?.label ?? action.action_id]);
			}

			remove.disabled = edited.then.length === 1;
			tools.append(remove, iconButton("add", "Add an action", () => {
				edited.then.splice(index + 1, 0, actionOf(offered[0]?.[0] ?? ""));
				render();
				changed();
			}));
			line.append(
				element("span", "wa-color-text-quiet", { "textContent": index === 0 ? "Then" : "and" }),
				select("rule-editor-action", actions, action.action_id, (actionId) => {
					edited.then[index] = actionOf(actionId);
					render();
					changed();
				})
			);

			// What it acts on (give process.argv): its argument follows.
			if (targets !== undefined) {
				const choices: [string, string][] = targets.map((id) => [id, catalog.targets[id]?.label ?? id]);

				if (action.target_id !== undefined && !targets.includes(action.target_id)) {
					choices.push([action.target_id, catalog.targets[action.target_id]?.label ?? action.target_id]);
				}

				line.append(select("rule-editor-action-target", choices, action.target_id ?? "", (targetId) => {
					const next = catalog.actionSchema(action.action_id, targetId);

					action["target_id"] = targetId;
					action.argument = next === undefined ? undefined : initial(next);
					render();
					changed();
				}));
			}

			if (schema !== undefined) {
				line.append(schemaInput(schema, action.argument, (argument) => {
					action.argument = argument;
					changed();
				}));
			}

			line.append(tools);
			block.append(line);
		}

		return block;
	};

	function render(): void {
		root.replaceChildren(renderCompound(edited.when, undefined, 0), renderActions());
	}

	render();

	return { "element": root, "rule": () => structuredClone(edited) };
}
