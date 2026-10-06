/**
 * A rule editor (packages/vscode/RULES.md): macOS's predicate editor — Finder's smart folders, Mail's rules — for a rule
 * `{ when, then }`. WHEN is rows of *target / operator / argument*, combined *all*, *any* or *none*, nestable; THEN is a
 * list of actions. Each row has − and +; ⌥-click on + adds a group. The model is ui-predicate's (kept JSON-compatible):
 * a compound `{ logicalType_id, predicates }` of comparisons `{ target_id, operator_id, argument }`.
 *
 * Nothing here knows what the targets are: the consumer passes the catalog — the targets, which operators each type of
 * target offers, the actions, and each argument's JSON Schema — and every argument's input is drawn from its schema: a
 * string is a text box (its `examples` offered), an `enum` a select, an array a list with − and +, a number a number,
 * a boolean a checkbox, anything else a JSON literal. One editor for every seam, rather than a form per feature.
 *
 * Vanilla DOM in VS Code's own look (its input, dropdown and toolbar colors, codicons): the workbench realm loads no
 * component library.
 */
import css from "./rule-editor.css?raw";

/** A JSON Schema (draft 2020-12): an object schema, or `true` / `false`. */
export type RuleSchema = boolean | Record<string, unknown>;

export interface RuleComparison { "target_id": string; "operator_id": string; "argument"?: unknown }
export interface RuleCompound { "logicalType_id": "all" | "any" | "none"; "predicates": RulePredicate[] }
export type RulePredicate = RuleComparison | RuleCompound;
export interface RuleAction { "action_id": string; "target_id"?: string; "argument"?: unknown }
export interface EditedRule { "when": RuleCompound; "then": RuleAction[]; "added"?: string }

/** What rows and actions can say. */
export interface RuleCatalog {
	"targets": Record<string, { "label": string; "type_id": string; "description"?: string }>;
	/** Each type of target's operators, in the order offered. */
	"types": Record<string, string[]>;
	"operators": Record<string, { "label": string }>;
	/** Each action, and the targets it acts on (`give` process.argv); without, it takes none. */
	"actions": Record<string, { "label": string; "targets"?: string[] }>;
	/** A row's argument's schema; undefined: it takes none. */
	"argumentSchema": (target_id: string, operator_id: string) => RuleSchema | undefined;
	/** An action's argument's schema, given its target; undefined: it takes none. */
	"actionSchema": (action_id: string, target_id?: string) => RuleSchema | undefined;
}

export interface RuleEditorOptions {
	"catalog": RuleCatalog;
	"rule": EditedRule;
	/** The rule as edited, after every change. */
	"onChange"?: (rule: EditedRule) => void;
}

export interface RuleEditor {
	"element": HTMLElement;
	/** The rule as it is now. */
	"rule": () => EditedRule;
}

const LOGICAL: Record<RuleCompound["logicalType_id"], string> = { "all": "All", "any": "Any", "none": "None" };

const isCompound = (predicate: RulePredicate): predicate is RuleCompound => "predicates" in predicate;

let styled = false;

/** A value a schema's input starts with. */
function initial(schema: RuleSchema | undefined): unknown {
	if (typeof schema !== "object") {
		return "";
	}

	if (Array.isArray(schema["enum"])) {
		return (schema["enum"] as unknown[])[0];
	}

	switch (Array.isArray(schema["type"]) ? (schema["type"] as string[])[0] : schema["type"]) {
		case "array":
			return Array.from({ "length": typeof schema["minItems"] === "number" ? schema["minItems"] : 0 }, () => initial(schema["items"] as RuleSchema | undefined));
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

/** A select of `options` ([value, label]), `value` chosen — with a chevron, as VS Code's own select boxes have. */
function select(className: string, options: [string, string][], value: string, changed: (value: string) => void): HTMLElement {
	const wrap = element("span", `rule-editor-select-wrap ${className}`);
	const each = element("select", "rule-editor-select");

	for (const [option, label] of options) {
		// eslint-disable-next-line webawesome/prefer-components -- the workbench realm doesn't load Web Awesome (the shell does)
		each.append(Object.assign(document.createElement("option"), { "value": option, "textContent": label, "selected": option === value }));
	}

	each.addEventListener("change", () => { changed(each.value); });
	wrap.append(each, element("span", "codicon codicon-chevron-down"));

	return wrap;
}

/** A codicon button. */
function iconButton(icon: string, title: string, clicked: (event: MouseEvent) => void): HTMLButtonElement {
	const each = element("button", "rule-editor-button", { "title": title, "type": "button" });

	each.append(element("span", `codicon codicon-${icon}`));
	each.addEventListener("click", clicked);

	return each;
}

/** Arguments as a command line: each as typed, quoted when it has to be. */
function joinCommandLine(args: unknown[]): string {
	return args.map((arg) => (typeof arg === "string" && arg !== "" && !/[\s"']/u.test(arg) ? arg : JSON.stringify(String(arg)))).join(" ");
}

/** A command line's arguments: split at spaces, but not inside quotes ("…" or '…'). */
function splitCommandLine(text: string): string[] {
	return [...text.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/gu)].map(([, double, single, bare]) => (double !== undefined ? double.replace(/\\(.)/gu, "$1") : single ?? bare ?? ""));
}

/** An input for a value of `schema`, showing `value`; `changed` with each valid edit. */
export function schemaInput(schema: RuleSchema | undefined, value: unknown, changed: (value: unknown) => void): HTMLElement {
	const object = typeof schema === "object" ? schema : {};
	const type = Array.isArray(object["type"]) ? undefined : object["type"];

	if (Array.isArray(object["enum"])) {
		const values = object["enum"] as unknown[];

		return select("rule-editor-enum", values.map((each, index) => [String(index), typeof each === "string" ? each : JSON.stringify(each)]), String(Math.max(0, values.findIndex((each) => JSON.stringify(each) === JSON.stringify(value)))), (index) => { changed(values[Number(index)]); });
	}

	// Arguments, as you'd type them after a command (process.argv's): one box, not a box per argument.
	if (type === "array" && object["format"] === "command-line") {
		const line = element("input", "rule-editor-argument command-line", { "spellcheck": false, "value": joinCommandLine(Array.isArray(value) ? value : []), "placeholder": "arguments, as a command line", "title": "As you'd type them after `node file.js`: separated by spaces, quoted to keep one together" });

		line.addEventListener("input", () => { changed(splitCommandLine(line.value)); });

		return line;
	}

	if (type === "array") {
		const items = Array.isArray(value) ? [...value as unknown[]] : [];
		const itemSchema = object["items"] as RuleSchema | undefined;
		// A list of lists (process.argv's runs): each on a line of its own.
		const list = element("span", `rule-editor-list${typeof itemSchema === "object" && itemSchema["type"] === "array" ? " nested" : ""}`);
		const draw = (): void => {
			list.replaceChildren();

			for (const [index, item] of items.entries()) {
				const entry = element("span", "rule-editor-list-item");

				entry.append(schemaInput(object["items"] as RuleSchema | undefined, item, (next) => { items[index] = next; changed([...items]); }), iconButton("close", "Remove it", () => { items.splice(index, 1); changed([...items]); draw(); }));
				list.append(entry);
			}

			list.append(iconButton("add", "Another", () => { items.push(initial(object["items"] as RuleSchema | undefined)); changed([...items]); draw(); }));
		};

		draw();

		return list;
	}

	if (type === "boolean") {
			const box = element("input", "rule-editor-check", { "type": "checkbox", "checked": value === true });

		box.addEventListener("change", () => { changed(box.checked); });

		return box;
	}

	const input = element("input", "rule-editor-argument", { "spellcheck": false });

	if (type === "string") {
		input.value = typeof value === "string" ? value : "";
		input.placeholder = object["format"] === "glob" ? "a glob: /workspace/**" : "";
		input.title = object["format"] === "glob" ? "* is anything but /, ** anything at all, ? one character" : "";

		input.addEventListener("input", () => { changed(input.value); });

		if (!Array.isArray(object["examples"])) {
			return input;
		}

		// Its examples offered as it's typed in.
		const wrap = element("span", "rule-editor-examples");
		const list = element("datalist", "", { "id": `rule-editor-examples-${Math.random().toString(36).slice(2)}` });

		for (const example of object["examples"] as unknown[]) {
			// eslint-disable-next-line webawesome/prefer-components -- the workbench realm doesn't load Web Awesome (the shell does)
			list.append(Object.assign(document.createElement("option"), { "value": String(example) }));
		}

		input.setAttribute("list", list.id);
		wrap.append(input, list);

		return wrap;
	}

	if (type === "number" || type === "integer") {
		input.type = "number";
		input.value = String(typeof value === "number" ? value : 0);
		input.addEventListener("input", () => { if (input.value !== "") { changed(Number(input.value)); } });

		return input;
	}

	// Anything else: a JSON literal (a bare word is taken as a string).
	input.value = typeof value === "string" && type === undefined && typeof schema !== "object" ? value : JSON.stringify(value ?? "");
	input.placeholder = "a literal: 'text', 4, true, [1, 2], { \"a\": 1 }";
	input.addEventListener("input", () => {
		try {
			changed(JSON.parse(input.value));
			input.classList.remove("invalid");
		} catch {
			if (typeof schema === "object") {
				input.classList.add("invalid");
			} else {
				changed(input.value);
			}
		}
	});

	return input;
}

/** A value as a sentence says it: a command line as typed, a list's items, a string as is. */
function sayValue(schema: RuleSchema | undefined, value: unknown): string {
	const object = typeof schema === "object" ? schema : {};

	if (Array.isArray(value)) {
		return object["format"] === "command-line" ? joinCommandLine(value) : value.map((each) => sayValue(object["items"] as RuleSchema | undefined, each)).join(object["items"] !== undefined && typeof object["items"] === "object" && (object["items"] as Record<string, unknown>)["type"] === "array" ? " · " : ", ");
	}

	return typeof value === "string" ? value : JSON.stringify(value);
}

/** A rule as a sentence, in the catalog's words: "capability is fs:write and resource matches /workspace/** → allow". */
export function describeRule(rule: EditedRule, catalog: RuleCatalog): string {
	const say = (predicate: RulePredicate, nested: boolean): string => {
		if (!isCompound(predicate)) {
			const schema = catalog.argumentSchema(predicate.target_id, predicate.operator_id);

			return [catalog.targets[predicate.target_id]?.label ?? predicate.target_id, catalog.operators[predicate.operator_id]?.label ?? predicate.operator_id, ...schema === undefined ? [] : [sayValue(schema, predicate.argument)]].join(" ");
		}

		const parts = predicate.predicates.map((each) => say(each, true));
		const joined = parts.join(predicate.logicalType_id === "any" ? " or " : " and ");
		const said = predicate.logicalType_id === "none" ? `not (${parts.join(" or ")})` : joined;

		return parts.length === 0 ? (predicate.logicalType_id === "any" ? "never" : "always") : nested && parts.length > 1 && predicate.logicalType_id !== "none" ? `(${said})` : said;
	};
	const actions = rule.then.map((action) => {
		const schema = catalog.actionSchema(action.action_id, action.target_id);

		return [catalog.actions[action.action_id]?.label ?? action.action_id, ...action.target_id === undefined ? [] : [catalog.targets[action.target_id]?.label ?? action.target_id], ...schema === undefined ? [] : [sayValue(schema, action.argument)]].join(" ");
	});

	return `${say(rule.when, false)} → ${actions.join(", then ")}`;
}

/** Edit a rule. */
export function ruleEditor({ catalog, rule, onChange }: RuleEditorOptions): RuleEditor {
	if (!styled) {
		styled = true;
		document.head.append(Object.assign(document.createElement("style"), { "textContent": css }));
	}

	const edited: EditedRule = structuredClone(rule);
	const root = element("div", "rule-editor");
	const firstTarget = Object.keys(catalog.targets)[0] ?? "";
	const operatorsOf = (target_id: string): string[] => catalog.types[catalog.targets[target_id]?.type_id ?? ""] ?? Object.keys(catalog.operators);
	const changed = (): void => { onChange?.(structuredClone(edited)); };
	const comparison = (target_id = firstTarget): RuleComparison => {
		const operator_id = operatorsOf(target_id)[0] ?? "";

		return { "target_id": target_id, "operator_id": operator_id, "argument": initial(catalog.argumentSchema(target_id, operator_id)) };
	};

	/** A row's − and +: remove it from `siblings` (not the last of the top level), add a row after it, or with ⌥ a group. */
	const tools = (siblings: RulePredicate[], index: number, removable: boolean): HTMLElement => {
		const span = element("span", "rule-editor-tools");
		const remove = iconButton("remove", "Remove this condition", () => { siblings.splice(index, 1); render(); changed(); });

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

	const renderComparison = (row: RuleComparison, siblings: RulePredicate[], index: number, removable: boolean): HTMLElement => {
		const line = element("div", "rule-editor-row");
		const targets: [string, string][] = Object.entries(catalog.targets).map(([id, { label }]) => [id, label]);

		// A target the catalog doesn't have (written by hand) is kept, as itself.
		if (catalog.targets[row.target_id] === undefined) {
			targets.push([row.target_id, row.target_id]);
		}

		const target = select("rule-editor-target", targets, row.target_id, (target_id) => {
			Object.assign(row, comparison(target_id));
			render();
			changed();
		});

		target.title = catalog.targets[row.target_id]?.description ?? "";

		const operator = select("rule-editor-operator", operatorsOf(row.target_id).map((id) => [id, catalog.operators[id]?.label ?? id]), row.operator_id, (operator_id) => {
			const before = catalog.argumentSchema(row.target_id, row.operator_id);
			const after = catalog.argumentSchema(row.target_id, operator_id);

			row.operator_id = operator_id;

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
			line.append(schemaInput(schema, row.argument, (argument) => { row.argument = argument; changed(); }));
		}

		line.append(tools(siblings, index, removable));

		return line;
	};

	const renderCompound = (compound: RuleCompound, siblings: RulePredicate[] | undefined, index: number): HTMLElement => {
		const group = element("div", `rule-editor-group${siblings === undefined ? " top" : ""}`);
		const head = element("div", "rule-editor-row rule-editor-head");
		const rows = element("div", "rule-editor-rows");
		const lead = siblings === undefined ? "When" : "";

		head.append(
			...lead === "" ? [] : [element("span", "rule-editor-word", { "textContent": lead })],
			select("rule-editor-logical", Object.entries(LOGICAL), compound.logicalType_id, (logical) => {
				compound.logicalType_id = logical as RuleCompound["logicalType_id"];
				changed();
			}),
			element("span", "rule-editor-word", { "textContent": "of these are true" })
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
			rows.append(iconButton("add", "Add a condition", () => { compound.predicates.push(comparison()); render(); changed(); }));
		}

		group.append(head, rows);

		return group;
	};

	/** An action as it starts: its first target, if it takes one, and an argument of that target's. */
	const actionOf = (action_id: string): RuleAction => {
		const targets = catalog.actions[action_id]?.targets;
		const target_id = targets?.[0];
		const schema = catalog.actionSchema(action_id, target_id);

		return { "action_id": action_id, ...target_id === undefined ? {} : { "target_id": target_id }, ...schema === undefined ? {} : { "argument": initial(schema) } };
	};
	// An action whose targets are all named per use (set's variables) is offered only where its host names some.
	const offered = Object.entries(catalog.actions).filter(([, { targets }]) => targets === undefined || targets.length > 0);

	const renderActions = (): HTMLElement => {
		const block = element("div", "rule-editor-then");

		for (const [index, action] of edited.then.entries()) {
			const line = element("div", "rule-editor-row");
			const tools = element("span", "rule-editor-tools");
			const remove = iconButton("remove", "Remove this action", () => { edited.then.splice(index, 1); render(); changed(); });
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
				element("span", "rule-editor-word", { "textContent": index === 0 ? "Then" : "and" }),
				select("rule-editor-action", actions, action.action_id, (action_id) => {
					edited.then[index] = actionOf(action_id);
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

				line.append(select("rule-editor-action-target", choices, action.target_id ?? "", (target_id) => {
					const next = catalog.actionSchema(action.action_id, target_id);

					action.target_id = target_id;
					action.argument = next === undefined ? undefined : initial(next);
					render();
					changed();
				}));
			}

			if (schema !== undefined) {
				line.append(schemaInput(schema, action.argument, (argument) => { action.argument = argument; changed(); }));
			}

			line.append(tools);
			block.append(line);
		}

		return block;
	};

	const render = (): void => {
		root.replaceChildren(renderCompound(edited.when, undefined, 0), renderActions());
	};

	render();

	return { "element": root, "rule": () => structuredClone(edited) };
}
