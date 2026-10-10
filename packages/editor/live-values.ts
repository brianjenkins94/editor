/**
 * Live values, as notes (LIVE-VALUES.md, step 6): a debug session's values — what each line bound, returned or chose,
 * a column per turn of the loop around it — beside the code in the component's notes margin (`showPane`), Bret Victor's
 * binary search. The debug adapter publishes them on the pod hub (`values.session.<id>` as they grow, `values.ended`);
 * this keeps the latest session's per file, shows them while the session lives, and takes them away when it ends.
 *
 * A function called more than once shows one call — its latest, or the one picked on its first line (`‹ 3/5 ›`).
 * Columns line up down a call: every line at the same loop depth has the same columns, each as wide as its widest
 * value, so a turn reads straight down; hovering one lights it on every line, a click holds it. The cursor's line opens
 * up, its values whole (the margin's cell lit at the cursor: pane.ts). What the bounds left out is said under the last
 * line. The margin also carries prose notes (`showNotes`, rendered by pane.tsx): both go in one `showPane` per file,
 * values first on a line.
 *
 * A capability stop asks on its line too (step 8): what the call would do — `writeFileSync '/workspace/out.txt'` — and
 * *Allow once*, *Allow always*, *Deny*, the choice sent back to the session (`debug.session.<id>.decide`), which
 * resumes it. *Allow this run* lets every call of the capability through until the run ends (a loop asks once), kept
 * nowhere. *Allow always* needs the resource the call reaches — known even when the line computes it (the worker runs a
 * fork of the stop to the call to see it).
 * *Rule…* opens the rule editor there (the component's, RULES.md), prefilled with the call — *capability is*, *resource
 * is*, *then allow* — to widen or narrow it (*resource matches* a glob) and apply it *Just this once*, or *Save as rule*
 * in my policy, the run going on as it decides. Or *give* the call's *result* instead of it (RULES.md, slice 2) —
 * starting from what it returned the last time it ran for real, when that's recorded (`capability.recorded`).
 *
 * A variable's row has *Mock…* on hover (LIVE-VALUES.md, "Mocking a value"): the rule editor, prefilled *program is
 * <this file>*, *at* <this statement> (a span reference, followed through edits), *then set* it to the value the run
 * had; the run's other variables are targets too. *Just this once* sets it at this stop and the run goes on with it
 * (`debug.session.<id>.setValue`, as the Variables view's Set Value does); *Save as rule* keeps it, and each run sets it
 * each time it gets there, without stopping (the adapter places the rule; the worker sets it after the statement runs).
 * process.argv's row — on the first line that
 * reads it, there before any run — has *Mock…*: the rule editor, prefilled *program is <this file>*, *then give
 * process.argv* the run's arguments, each value a run of its own; *Run* runs the file with them, once; *Save as rule*
 * keeps it in my policy, and every run of the file is given them (`rules.set`; the row shows what a rule gives,
 * `rules.given`).
 *
 * The margin is always open beside a JavaScript or TypeScript file, with or without anything to show: it's the file's
 * runtime column — coverage in its gutter column, left of the code (`showMarks`, from coverage.ts), notes, values,
 * decisions. In that column too, how the last run ended short: ✕ on the line it crashed on (the error on hover), ■ on
 * the one it was stopped at — until the file runs again.
 *
 * Everything a run put on a line follows its code through edits and cosmetic changes (a reformat, a reindent): each is
 * anchored by its node's range in the text that ran (anchors.ts, BABLR spans) and drawn where that code is now; what
 * lost its code goes.
 */
import type * as vscodeApi from "vscode";
import type { Hub } from "@brianjenkins94/hub";
import type { EditedRule, PaneEntry, PaneMark, RuleCatalog, RulePredicate, RuleSchema } from "@brianjenkins94/monaco-vscode-api/main";
import type { AskEvent, RunEnd } from "@brianjenkins94/run-contract";
import type { CapabilityChoice } from "./extensions/worker-pod/capability-stops";

/** A capability stop's question, as the margin shows it on its line (the run contract's `ask`, its file and text apart). */
type CapabilityAsk = Omit<AskEvent, "file" | "source">;
import type { LiveBatch, LiveCall, LiveValue } from "./extensions/worker-pod/live-values";
import type { Range } from "./anchors";
import type { ProfiledLine } from "./coverage";
import { Anchors } from "./anchors";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { parseInputs } from "./extensions/worker-pod/inputs";
import { describeRule, ruleEditor, showPane, showPaneViews } from "@brianjenkins94/monaco-vscode-api/main";
import css from "./live-values.css?raw";

/** A prose note: Markdown on a line span (0-based, inclusive). */
export interface Note { "id": string; "fromLine": number; "toLine": number; "text": string }

/** One line of values as drawn: its label (`mid =`), then a value (`inline`) or a cell per column. */
interface Row { "line": number; "label": string; "name"?: string; "cells": (Cell | undefined)[]; "inline"?: Cell; "group": string; "widths": number[]; "picker"?: Picker; "at"?: Range; "input"?: boolean }

/** What a rule gives a file's process.argv: the rule, and its values, each a run's arguments. */
interface Given { "rule": EditedRule; "values": string[][] }

/** A function's calls to pick between, on its first line: which (`function:line`), the one shown (0-based), how many. */
interface Picker { "function": string; "index": number; "count": number }

/** A cell's text and look (`string`, `number`, `boolean`, `branch`). */
interface Cell { "text": string; "kind": string }

/** A session's values, and what's picked in them: a function's call (by `function:line`; none, its latest) and a held
 *  column. */
interface Session { "id": string; "values": LiveValue[]; "calls": Map<number, LiveCall>; "dropped": number; "picked": Map<string, number>; "held"?: string; "anchors"?: Anchors }

/** A column no wider than this many characters; a longer value is cut short, whole on hover. */
const MAX_WIDTH = 24;

/** What a file's Margin shows, as plain data (debug-mcp's `margin` tool, through `margin.state`): set each time it's
 *  drawn. Lines are 1-based, as an agent reads code. */
interface MarginState {
	"file": string;
	"values": { "line": number; "label": string; "cells": string[] }[];
	"dropped": number;
	"ask"?: { "line": number; "call": string; "capability": string; "resource": string; "resolved": boolean };
	"end"?: { "line": number; "kind": string; "message"?: string };
	"marks": { "line": number; "kind": string; "title"?: string }[];
	"cards": { "fromLine": number; "toLine": number; "title": string }[];
	"notes": { "fromLine": number; "toLine": number; "text": string }[];
	"runLog"?: RunLog;
}

/** Each drawn file's MarginState, by URI. */
const margins = new Map<string, MarginState>();

/** The latest session's values, per file URI — kept once it ends, until the next session of the file tells its own. */
const sessions = new Map<string, Session>();
/** Prose notes, per file URI. */
const notes = new Map<string, Note[]>();
/** Each file's marks for the margin's gutter column (coverage), per file URI. */
const marked = new Map<string, PaneMark[]>();
/** Where each file's last run's work went (coverage.ts: tsval's profile), on the lines its statements are on now. */
const profiles = new Map<string, ProfiledLine[]>();
/** How each file's last run ended short, per file URI. */
const ends = new Map<string, RunEnd & { "anchors"?: Anchors }>();
/** The code files shown in an editor: their margin stays open, empty or not. */
const open = new Set<string>();
/** The languages whose files get a margin always. */
const CODE = new Set(["javascript", "javascriptreact", "typescript", "typescriptreact"]);
/** The capability stop a session is at, per file URI: what it asks. */
const asks = new Map<string, { "session": string; "ask": CapabilityAsk; "anchors"?: Anchors }>();
/** The workbench's extension API (set by `installLiveValues`): the documents' text, BABLR's spans. */
let api: typeof vscodeApi | undefined;
/** Each file's latest draw: an earlier one still placing its lines gives way. */
const drawing = new Map<string, number>();
/** Sends a capability stop's choice back to its session (set by `installLiveValues`). */
let choose: ((session: string, choice: CapabilityChoice, rule?: EditedRule, give?: unknown) => Promise<unknown>) | undefined;
/** What a call returned the last time it ran for real (a preview's fetch, recorded), or null (set by `installLiveValues`). */
let recordedOf: ((capability: string, resource: string) => Promise<{ "value": unknown; "at": string } | null>) | undefined;
/** Sets a variable at a session's stop (set by `installLiveValues`). */
let setValueAt: ((session: string, name: string, value: string) => Promise<unknown>) | undefined;
/** What a rule gives a file's process.argv, changing my policy by a rule editor's rule, and running a file with given
 *  arguments, each a run (set by `installLiveValues`). */
let rulesGiven: ((path: string) => Promise<Given | null>) | undefined;
let rulesSet: ((previous: EditedRule | undefined, rule: EditedRule | undefined) => Promise<unknown>) | undefined;
let runFile: ((path: string, cases: string[][]) => Promise<unknown>) | undefined;
/** The rules placed in a file, where they are in it now (set by `installLiveValues`). */
let rulesPlaced: ((path: string) => Promise<PlacedRule[]>) | undefined;
/** What a rule gives each file's process.argv, as last read (null: nothing; undefined: not read yet). */
const givenArgv = new Map<string, Given | null>();
/** Who's told when the policy files change (the Rules view), besides the margin. */
const rulesChanged = new Set<() => void>();

/** Be told when the policy files change — by a rule editor anywhere, or by hand. */
export function onRulesChanged(listener: () => void): void {
	rulesChanged.add(listener);
}

/** The variables a rule tests or sets (`variables.<name>`), by name. */
export function variablesOf(rule: EditedRule): string[] {
	const names = new Set<string>();
	const walk = (predicate: RulePredicate): void => {
		if ("predicates" in predicate) {
			predicate.predicates.forEach(walk);
		} else if (predicate.target_id.startsWith("variables.")) {
			names.add(predicate.target_id.slice("variables.".length));
		}
	};

	walk(rule.when);

	for (const action of rule.then) {
		if (action.target_id?.startsWith("variables.") === true) {
			names.add(action.target_id.slice("variables.".length));
		}
	}

	return [...names];
}

/** Arguments as a command line, as the Mock box takes them. */
function commandLine(args: string[]): string {
	return args.map((arg) => (arg === "" || /[\s"'|]/u.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}
/** The cells of each column on screen, by group and column: to light a column on every line. */
let columns = new Map<string, HTMLElement[]>();

/** A value's look, by what it reads as. */
function kindOf(value: LiveValue): string {
	// (process.argv's look is `argv`: `live-values-input` is the Mock's box.)
	if (value.kind === "input") {
		return "argv";
	}

	if (value.kind === "branch" || value.kind === "set" || value.kind === "skip") {
		return value.kind;
	}

	return /^['"`]/u.test(value.value) ? "string" : /^-?\d/u.test(value.value) ? "number" : value.value === "true" || value.value === "false" ? "boolean" : "";
}

/** What a value reads as in a cell: a branch its arm, anything else its preview. */
function textOf(value: LiveValue): string {
	return value.kind === "branch" ? (value.value === "0" ? "then" : "else") : value.value;
}

/** A line's values in one turn, as one cell: the value, or `name = value` each when the line binds more than one name. */
function cellOf(values: LiveValue[], named: boolean): Cell {
	const last = new Map<string, LiveValue>();

	for (const value of values) {
		last.delete(value.name);
		last.set(value.name, value);
	}

	const shown = [...last.values()];

	return { "text": shown.map((value) => (named ? `${value.name} = ${textOf(value)}` : textOf(value))).join(", "), "kind": shown.length === 1 ? kindOf(shown[0]!) : "" };
}

/** Turns as a column's key, and in order: outermost loop first, numerically. */
function compareTurns(a: string, b: string): number {
	const left = a.split(".").map(Number);
	const right = b.split(".").map(Number);

	for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
		if ((left[index] ?? -1) !== (right[index] ?? -1)) {
			return (left[index] ?? -1) - (right[index] ?? -1);
		}
	}

	return 0;
}

/** A line's anchor: the range of the first of its values that has one. */
function anchorOf(values: LiveValue[]): { "at"?: Range } {
	const at = values.find((value) => value.at !== undefined)?.at;

	return at === undefined ? {} : { "at": at };
}

/** Each value set by hand at a stop, moved to its variable's own row — where it was last bound in the same call, in that
 *  row's turn (none, outside a loop) — rather than the line the run stopped at. */
function homed(values: LiveValue[]): LiveValue[] {
	return values.map((value, index) => {
		if (value.kind !== "set") {
			return value;
		}

		const home = values.slice(0, index).findLast((other) => other.kind !== "set" && other.name === value.name && other.call === value.call);

		return home === undefined ? value : { ...value, "line": home.line, "turns": home.turns.length === 0 ? [] : value.turns, ...home.at === undefined ? {} : { "at": home.at } };
	});
}

/** A session's rows: a call of each function (its latest, or the one `picked`) and the top level, a row per line that
 *  has values; a function called more than once has its picker on its first line. */
export function rowsOf(values: LiveValue[], calls: Map<number, LiveCall>, picked = new Map<string, number>()): Row[] {
	const byFunction = new Map<string, LiveCall[]>();

	for (const call of calls.values()) {
		const key = `${call.name}:${call.line}`;

		byFunction.set(key, [...byFunction.get(key) ?? [], call]);
	}

	const shown = new Map([...byFunction].map(([key, each]) => {
		const ordered = each.toSorted((left, right) => left.id - right.id);
		const index = Math.min(picked.get(key) ?? ordered.length - 1, ordered.length - 1);

		return [key, { "call": ordered[index]!, "index": index, "count": ordered.length }];
	}));
	const shownCalls = new Set([0, ...[...shown.values()].map((each) => each.call.id)]);
	const byLine = new Map<number, LiveValue[]>();

	for (const value of homed(values).filter((candidate) => shownCalls.has(candidate.call))) {
		byLine.set(value.line, [...byLine.get(value.line) ?? [], value]);
	}

	// Columns per call and loop depth: every turn any line at that depth ran in.
	const keys = new Map<string, Set<string>>();

	for (const value of [...byLine.values()].flat()) {
		const group = `${value.call}/${value.turns.length}`;

		keys.set(group, (keys.get(group) ?? new Set()).add(value.turns.join(".")));
	}

	const ordered = new Map([...keys].map(([group, set]) => [group, [...set].toSorted(compareTurns)]));
	const rows: Row[] = [];

	for (const [line, lineValues] of [...byLine].toSorted(([a], [b]) => a - b)) {
		// A line belongs to one call; its loop depth is its deepest value's.
		const call = lineValues.at(-1)!.call;
		const depth = Math.max(...lineValues.map((value) => value.turns.length));
		const inDepth = lineValues.filter((value) => value.turns.length === depth);
		const names = [...new Set(inDepth.map((value) => value.name))];
		const named = names.length > 1;
		const only = inDepth[0]!;
		const binds = !named && (only.kind === "bind" || only.kind === "set" || only.kind === "input");
		const label = named ? "" : binds ? `${only.name} =` : only.kind === "return" ? "return" : only.name;
		const group = `${call}/${depth}`;

		if (depth === 0) {
			rows.push({ "line": line, "label": label, ...binds ? { "name": only.name } : {}, "cells": [], "inline": cellOf(inDepth, named), "group": group, "widths": [], ...anchorOf(inDepth), ...only.kind === "input" ? { "input": true } : {} });

			continue;
		}

		const turns = ordered.get(group) ?? [];

		rows.push({ "line": line, "label": label, ...binds ? { "name": only.name } : {}, "cells": turns.map((turn) => {
			const inTurn = inDepth.filter((value) => value.turns.join(".") === turn);

			return inTurn.length === 0 ? undefined : cellOf(inTurn, named);
		}), "group": group, "widths": [], ...anchorOf(inDepth) });
	}

	// A function called more than once: its picker on its first line, a row of its own if nothing's there.
	for (const [key, { call, index, count }] of shown) {
		if (count > 1) {
			const picker = { "function": key, "index": index, "count": count };
			const row = rows.find((candidate) => candidate.line === call.line);

			if (row === undefined) {
				rows.push({ "line": call.line, "label": "", "cells": [], "group": `${call.id}/0`, "widths": [], "picker": picker, ...call.at === undefined ? {} : { "at": call.at } });
			} else {
				row.picker = picker;
			}
		}
	}

	rows.sort((left, right) => left.line - right.line);

	// Each group's columns as wide as their widest cell.
	for (const group of new Set(rows.map((row) => row.group))) {
		const members = rows.filter((row) => row.group === group);
		const widths = (members[0]?.cells ?? []).map((_, index) => Math.min(MAX_WIDTH, Math.max(1, ...members.map((row) => row.cells[index]?.text.length ?? 0))));

		for (const row of members) {
			row.widths = widths;
		}
	}

	return rows;
}

/** A row's element: its picker, its label (as wide as its call's widest), then its value or its columns. */
function renderRow(row: Row, labelWidth: number, session: Session | undefined, uri: string, redraw: () => void, element: HTMLElement): void {
	const line = document.createElement("div");
	const label = document.createElement("span");
	const cell = (value: Cell | undefined, className: string): HTMLSpanElement => {
		const span = document.createElement("span");

		span.className = `live-values-cell ${className}${value === undefined || value.kind === "" ? "" : ` live-values-${value.kind}`}`;
		span.textContent = value?.text ?? "";
		span.title = value?.text ?? "";

		return span;
	};

	line.className = "live-values-row";
	line.dataset["line"] = String(row.line);

	if (row.picker !== undefined) {
		const { "function": key, index, count } = row.picker;
		const picker = document.createElement("span");
		const step = (by: number, text: string, title: string): HTMLButtonElement => {
			// eslint-disable-next-line webawesome/prefer-components -- the workbench realm doesn't load Web Awesome (the shell does)
			const button = document.createElement("button");

			button.className = "live-values-step";
			button.textContent = text;
			button.title = title;
			button.disabled = index + by < 0 || index + by >= count;
			button.addEventListener("click", () => {
				// The latest picked is no pick: it follows the calls still coming.
				if (index + by === count - 1) {
					session?.picked.delete(key);
				} else {
					session?.picked.set(key, index + by);
				}

				redraw();
			});

			return button;
		};

		picker.className = "live-values-picker";
		picker.title = `Call ${index + 1} of ${count}`;
		picker.append(step(-1, "‹", "The call before"), `${index + 1}/${count}`, step(1, "›", "The call after"));
		line.append(picker);
	}
	label.className = "live-values-label";
	label.textContent = row.label.padEnd(labelWidth);

	// A line binding several names (a function's parameters) names each in its value: no label to line up.
	if (row.label !== "") {
		line.append(label);
	}

	if (row.inline !== undefined) {
		line.append(cell(row.inline, "inline"));
	}

	for (const [index, value] of row.cells.entries()) {
		const span = cell(value, "turn");
		const key = `${row.group}#${index}`;

		// eslint-disable-next-line webawesome/no-inline-styles -- dynamic geometry: a column as wide as its widest value
		span.style.width = `${(row.widths[index] ?? 1) + 2}ch`;
		span.classList.toggle("held", session?.held === key);
		span.addEventListener("mouseenter", () => { light(key, true); });
		span.addEventListener("mouseleave", () => { light(key, false); });
		span.addEventListener("click", () => { if (session !== undefined) { hold(session, key); } });
		columns.set(key, [...columns.get(key) ?? [], span]);
		line.append(span);
	}

	if (row.input === true) {
		renderArgv(row, uri, line, redraw);
	} else if (row.name !== undefined) {
		renderMock(row, row.name, session, uri, line, redraw);
	}

	// The rule being made on this row, under it.
	const panelKey = row.input === true ? `${uri}#process.argv` : row.name === undefined ? undefined : `${uri}#${row.name}`;

	element.append(line, ...panelKey !== undefined && making.has(panelKey) ? [making.get(panelKey)!] : []);
}

/** process.argv's row: what a rule gives it, if one does (the run's own value struck through), and *Mock…*. */
function renderArgv(row: Row, uri: string, line: HTMLElement, redraw: () => void): void {
	const given = givenArgv.get(uri);
	const key = `${uri}#process.argv`;
	const tools = Object.assign(document.createElement("span"), { "className": "live-values-mock shown" });
	// eslint-disable-next-line webawesome/prefer-components -- the workbench realm doesn't load Web Awesome (the shell does)
	const open = Object.assign(document.createElement("button"), { "className": "live-values-choice mock", "textContent": "Mock…", "title": "Give the program arguments of your own: once, or by a rule, every run" });

	line.classList.toggle("mocking", given !== null && given !== undefined);
	line.classList.add("argv");

	if (given !== null && given !== undefined) {
		tools.append(Object.assign(document.createElement("span"), {
			"className": "live-values-given",
			"textContent": given.values.map(commandLine).join("  ·  "),
			"title": `Given by a rule in your policy${given.values.length > 1 ? `: ${given.values.length} runs, one after another` : ""}`
		}));
	}

	open.disabled = making.has(key);
	open.addEventListener("click", () => {
		open.disabled = true;
		void openMock(uri, row, () => { making.delete(key); redraw(); }).then((panel) => {
			making.set(key, panel);
			redraw();
		}, (error: unknown) => {
			open.disabled = false;
			open.title = String(error);
		});
	});
	tools.append(open);
	line.append(tools);
}

/** A variable's Mock (LIVE-VALUES.md, "Mocking a value"): *Mock…*, on its row's hover — the rule editor, prefilled with
 *  this place and this value. */
function renderMock(row: Row, name: string, session: Session | undefined, uri: string, line: HTMLElement, redraw: () => void): void {
	const key = `${uri}#${name}`;
	const tools = Object.assign(document.createElement("span"), { "className": `live-values-mock${making.has(key) ? " shown" : ""}` });
	// eslint-disable-next-line webawesome/prefer-components -- the workbench realm doesn't load Web Awesome (the shell does)
	const open = Object.assign(document.createElement("button"), { "className": "live-values-choice mock", "textContent": "Mock…", "title": "Give it another value: at this stop, or by a rule, each time the program gets here" });

	open.disabled = making.has(key) || row.at === undefined || session?.anchors === undefined;
	open.addEventListener("click", () => {
		open.disabled = true;
		void openVariableMock(uri, row, name, session!, () => { making.delete(key); redraw(); }).then((panel) => {
			making.set(key, panel);
			redraw();
		}, (error: unknown) => {
			open.disabled = false;
			open.title = error instanceof Error ? error.message : String(error);
		});
	});
	tools.append(open);
	line.append(tools);
}

/** A click holds a column lit; another lets it go. */
function hold(session: Session, key: string): void {
	session.held = session.held === key ? undefined : key;

	for (const [column, cells] of columns) {
		for (const cell of cells) {
			cell.classList.toggle("held", column === session.held);
		}
	}
}

function light(key: string, on: boolean): void {
	for (const cell of columns.get(key) ?? []) {
		cell.classList.toggle("lit", on);
	}
}

/** The rule being made, by where — a capability stop's session, or `<uri>#process.argv` — its panel, kept as it is
 *  across the margin's redraws. */
const making = new Map<string, HTMLElement>();

export type PolicyModule = typeof import("@brianjenkins94/util/silo/policy");

/** What a rule as edited would do here: said under it, and whether its buttons can act on it. */
export interface Verdict { "text": string; "ok": boolean; "refused"?: boolean }

/** silo's catalog, as the rule editor takes it. */
export const catalogOf = (policy: PolicyModule): RuleCatalog => ({ "targets": policy.TARGETS, "types": policy.TYPES, "operators": policy.OPERATORS, "actions": policy.ACTIONS, "argumentSchema": policy.argumentSchema, "actionSchema": policy.actionSchema });

/** A button under a rule: what it does with the rule as edited (resolving once done — the panel's host closes it, or
 *  its stop goes on and takes it away); `always`, enabled whatever the verdict. */
export interface PanelButton { "label": string; "className": string; "title": string; "act": (rule: EditedRule) => Promise<unknown>; "always"?: boolean }

/** The rule editor (the component's, RULES.md), with silo's catalog — in the margin, and in the Rules view: under it,
 *  what the rule as edited would do here (`judge`), then its buttons. silo's policy (and ajv with it) loads on first
 *  use, not with the workbench. */
export function rulePanel(policy: PolicyModule, rule: EditedRule, judge: (rule: EditedRule) => Verdict, actions: PanelButton[], catalog: RuleCatalog = catalogOf(policy)): HTMLElement {
	const panel = Object.assign(document.createElement("div"), { "className": "live-values-rule" });
	const status = Object.assign(document.createElement("div"), { "className": "live-values-rule-status" });
	const buttons = Object.assign(document.createElement("div"), { "className": "live-values-choices" });
	const update = (edited: EditedRule): void => {
		const verdict = judge(edited);

		status.textContent = verdict.text;
		status.classList.toggle("refused", verdict.refused === true);

		for (const [index, each] of [...buttons.children].entries()) {
			(each as HTMLButtonElement).disabled = actions[index]?.always !== true && !verdict.ok;
		}
	};
	const editor = ruleEditor({
		"catalog": catalog,
		"rule": rule,
		"onChange": update
	});

	for (const { label, className, title, act } of actions) {
		// eslint-disable-next-line webawesome/prefer-components -- the workbench realm doesn't load Web Awesome (the shell does)
		const each = Object.assign(document.createElement("button"), { "className": `live-values-choice ${className}`, "textContent": label, "title": title });

		each.addEventListener("click", () => {
			for (const other of buttons.querySelectorAll("button")) {
				other.disabled = true;
			}

			void act(editor.rule()).catch((error: unknown) => {
				update(editor.rule());
				status.textContent = error instanceof Error ? error.message : String(error);
				status.classList.add("refused");
			});
		});
		buttons.append(each);
	}

	panel.append(editor.element, status, buttons);
	update(editor.rule());

	return panel;
}

/** The first allow / deny / ask a rule has. */
export const decisionOf = (rule: EditedRule): string | undefined => rule.then.find(({ action_id }) => ["allow", "deny", "skip", "ask"].includes(action_id))?.action_id;

/** What a rule as edited would do to a call: whether it covers it (`resolved`: what it reaches is known) and what it
 *  decides — ok when it allows or denies it. */
export function callVerdict(policy: PolicyModule, rule: EditedRule, subject: { "capability": string; "resource"?: string }, resolved = true, canGive = false): Verdict {
	const problem = policy.problemOf(rule);
	const covers = problem === undefined && policy.ruleMatches(rule, subject);
	const decision = decisionOf(rule);
	// A result given instead of the call: only where something stands in for it (the debugger), not a real call.
	const gives = rule.then.some((action) => action.action_id === "give" && action.target_id === "result");

	return {
		"text": problem ?? (!covers
			? `Doesn't cover this call${resolved ? "" : " — what it reaches isn't known before the line runs"}`
			: gives ? (canGive ? "Covers this call: gives it this result instead" : "A result can only be given in the debugger, where nothing real is called")
				: decision === "allow" ? "Covers this call: allows it" : decision === "deny" ? "Covers this call: denies it" : decision === "skip" ? "Covers this call: skips it" : decision === "ask" ? "Covers this call, and asks — as now" : "Covers this call, but doesn't decide it"),
		"ok": covers && (gives ? canGive : decision === "allow" || decision === "deny" || decision === "skip"),
		"refused": problem !== undefined
	};
}

/** The result a rule gives a call, when it gives one. */
const resultOf = (rule: EditedRule): { "value": unknown } | undefined => {
	const give = rule.then.find((action) => action.action_id === "give" && action.target_id === "result");

	return give === undefined ? undefined : { "value": give.argument };
};

/** A rule about a call, as it starts: its capability, its resource (when known), then allow. */
export const callRule = (capability: string, resource?: string): EditedRule => ({
	"when": { "logicalType_id": "all", "predicates": [
		{ "target_id": "capability", "operator_id": "is", "argument": capability },
		...resource === undefined ? [] : [{ "target_id": "resource", "operator_id": "is", "argument": resource }]
	] },
	"then": [{ "action_id": "allow" }]
});

/** The rule editor at a capability stop, prefilled with the call: whether the rule as edited covers this call and what
 *  it decides, then *Just this once* (decide this call so), *Save as rule* (in my policy, and decide it so), *Cancel*. */
async function openRule(session: string, ask: CapabilityAsk, close: () => void): Promise<HTMLElement> {
	const policy = await import("@brianjenkins94/util/silo/policy");
	const subject = ask.resolved ? { "capability": ask.capability, "resource": ask.resource } : { "capability": ask.capability };
	// What this call returned the last time it ran for real (a preview's fetch): given instead, to start with.
	const recorded = ask.resolved ? await recordedOf?.(ask.capability, ask.resource).catch(() => null) ?? null : null;
	const rule = callRule(ask.capability, ask.resolved ? ask.resource : undefined);

	if (recorded !== null) {
		rule.then = [{ "action_id": "give", "target_id": "result", "argument": recorded.value }];
	}

	return rulePanel(policy, rule, (edited) => {
		const verdict = callVerdict(policy, edited, subject, ask.resolved, true);

		return recorded !== null && verdict.ok && JSON.stringify(resultOf(edited)?.value) === JSON.stringify(recorded.value) ? { ...verdict, "text": `Covers this call: gives it what it returned on ${new Date(recorded.at).toLocaleString()}` } : verdict;
	}, [
		{ "label": "Just this once", "className": "once", "title": "Decide this call as the rule does, and stop here again next time", "act": async (edited) => (resultOf(edited) === undefined ? choose?.(session, decisionOf(edited) === "deny" ? "deny" : decisionOf(edited) === "skip" ? "skip" : "allow-once") : choose?.(session, "give-once", undefined, resultOf(edited)!.value)) },
		{ "label": "Save as rule", "className": "save", "title": "Keep it in your policy (.silo/<you>.policy.json), and decide this call by it", "act": async (rule) => choose?.(session, "rule", rule) },
		{ "label": "Cancel", "className": "cancel", "title": "Back to the choices", "act": async () => { close(); }, "always": true }
	]);
}

/** The rule editor on process.argv's row: the rule giving it now, or one prefilled — *program is <this file>*, *then
 *  give process.argv* the run's own arguments — then whether it covers this file and how many runs it gives, and *Run*
 *  (with them, once), *Save as rule* (in my policy: every run of the file is given them), *Remove* (the rule giving it
 *  now), *Cancel*. */
async function openMock(uri: string, row: Row, close: () => void): Promise<HTMLElement> {
	const policy = await import("@brianjenkins94/util/silo/policy");
	const path = api?.Uri.parse(uri).path ?? "";
	const program = api?.workspace.asRelativePath(api.Uri.parse(uri), false) ?? path;
	const given = givenArgv.get(uri) ?? undefined;
	const valuesOf = (rule: EditedRule): string[][] => {
		const give = rule.then.find((action) => action.action_id === "give" && action.target_id === "process.argv");

		return Array.isArray(give?.argument) ? (give.argument as unknown[]).filter((each): each is string[] => Array.isArray(each)) : [];
	};
	const judge = (rule: EditedRule): Verdict => {
		const problem = policy.problemOf(rule);
		const covers = problem === undefined && policy.ruleMatches(rule, { "program": program });
		const runs = valuesOf(rule).length;

		return {
			"text": problem ?? (!covers ? `Doesn't cover ${program}` : runs === 0 ? "Gives process.argv nothing" : `Gives ${program} ${runs === 1 ? "these arguments" : `${runs} runs, one after another`}`),
			"ok": covers && runs > 0,
			"refused": problem !== undefined
		};
	};
	const saved = async (): Promise<void> => {
		givenArgv.set(uri, await rulesGiven?.(path) ?? null);
		close();
	};

	return rulePanel(policy, given?.rule ?? {
		"when": { "logicalType_id": "all", "predicates": [{ "target_id": "program", "operator_id": "is", "argument": program }] },
		"then": [{ "action_id": "give", "target_id": "process.argv", "argument": [parseInputs(row.inline?.text ?? "")[0] ?? []] }]
	}, judge, [
		{ "label": "Run", "className": "once", "title": "Run the file with them, once — each a run of its own", "act": async (rule) => { void runFile?.(path, valuesOf(rule)); close(); } },
		{ "label": "Save as rule", "className": "save", "title": "Keep it in your policy (.silo/<you>.policy.json): every run of the file is given them", "act": async (rule) => { await rulesSet?.(given?.rule, rule); await saved(); } },
		...given === undefined ? [] : [{ "label": "Remove", "className": "remove", "title": "Take the rule away: the file's runs get their own arguments again", "act": async () => { await rulesSet?.(given.rule, undefined); await saved(); }, "always": true }],
		{ "label": "Cancel", "className": "cancel", "title": "Close it, changing nothing", "act": async () => { close(); }, "always": true }
	]);
}

/** A value as a rule holds it, from its text in a cell: a number, a boolean, a string's text, else the text. */
function valueOf(text: string, kind: string): unknown {
	switch (kind) {
		case "number":
			return Number(text);
		case "boolean":
			return text === "true";
		case "string":
			return text.startsWith("\"") ? JSON.parse(text) as unknown : text.slice(1, -1).replace(/\\(.)/gu, "$1");
		default:
			return text;
	}
}

/** The schema of a value of a cell's kind — what a rule's input for it is drawn from. */
const schemaOfKind = (kind: string): RuleSchema => (kind === "number" || kind === "string" || kind === "boolean" ? { "type": kind } : true);

/** silo's catalog, with `variables.<name>` for each variable `values` saw (its latest value's kind): what a rule placed
 *  where they're in scope can test, and set. */
export function withVariables(policy: PolicyModule, values: { "name": string; "kind": string }[]): RuleCatalog {
	const base = catalogOf(policy);
	const variables = new Map(values.map(({ name, kind }) => [`variables.${name}`, { "name": name, "kind": kind }]));

	return {
		...base,
		"targets": { ...base.targets, ...Object.fromEntries([...variables].map(([id, { name, kind }]) => [id, { "label": name, "type_id": kind === "number" || kind === "boolean" ? kind : "string", "description": `The variable ${name}, where the rule is placed` }])) },
		"actions": { ...base.actions, "set": { ...base.actions["set"]!, "targets": [...variables.keys()] } },
		"argumentSchema": (target_id, operator_id) => (variables.has(target_id) ? policy.OPERATORS[operator_id]?.argument(schemaOfKind(variables.get(target_id)!.kind)) : base.argumentSchema(target_id, operator_id)),
		"actionSchema": (action_id, target_id) => (action_id === "set" && target_id !== undefined && variables.has(target_id) ? schemaOfKind(variables.get(target_id)!.kind) : base.actionSchema(action_id, target_id))
	};
}

/** The rule editor on a variable's row: *program is <this file>*, *at* <this statement> (a span reference, followed
 *  through edits), *then set* <it> to the value the run had — then *Just this once* (set at this stop: the run goes on
 *  with it), *Save as rule* (in my policy: each run sets it each time it gets here, without stopping), *Cancel*. */
async function openVariableMock(uri: string, row: Row, name: string, session: Session, close: () => void): Promise<HTMLElement> {
	const policy = await import("@brianjenkins94/util/silo/policy");
	const program = api?.workspace.asRelativePath(api.Uri.parse(uri), false) ?? "";
	const [place] = await Promise.resolve(api?.commands.executeCommand<unknown[] | undefined>("editor.annotations.refer", session.anchors!.text, program, [{ "start": row.at![0], "end": row.at![1] }])).catch(() => undefined) ?? [];

	if (place === undefined || place === null) {
		throw new Error("This line can't be placed: BABLR doesn't read this file");
	}

	// The variables the run saw, each by its latest value: targets to test, and to set.
	const latest = new Map<string, LiveValue>();

	for (const value of session.values) {
		if (value.kind === "bind" || value.kind === "set") {
			latest.set(value.name, value);
		}
	}

	const cell = row.inline ?? row.cells.findLast((each) => each !== undefined);
	const catalog = withVariables(policy, [...latest].map(([each, value]) => ({ "name": each, "kind": kindOf(value) })));
	const variables = Object.fromEntries([...latest].map(([each, value]) => [each, valueOf(value.value, kindOf(value))]));
	const sets = (rule: EditedRule): { "name": string; "value": unknown }[] => rule.then.filter((action) => action.action_id === "set" && action.target_id?.startsWith("variables.") === true).map((action) => ({ "name": action.target_id!.slice("variables.".length), "value": action.argument }));
	const judge = (rule: EditedRule): Verdict => {
		const problem = policy.problemOf(rule);
		const covers = problem === undefined && policy.ruleMatches(rule, { "program": program, "at": place, "variables": variables });
		const names = sets(rule).map((each) => each.name);

		return {
			"text": problem ?? (!covers ? "Doesn't cover this place, as the run is now" : names.length === 0 ? "Sets nothing" : `Sets ${names.join(", ")} each time the program gets here`),
			"ok": covers && names.length > 0,
			"refused": problem !== undefined
		};
	};

	return rulePanel(policy, {
		"when": { "logicalType_id": "all", "predicates": [{ "target_id": "program", "operator_id": "is", "argument": program }, { "target_id": "at", "operator_id": "is", "argument": place }] },
		"then": [{ "action_id": "set", "target_id": `variables.${name}`, "argument": valueOf(cell?.text ?? "", cell?.kind ?? "") }]
	}, judge, [
		{ "label": "Just this once", "className": "once", "title": "Set it at this stop: the run goes on with it", "act": async (rule) => {
			for (const each of sets(rule)) {
				await setValueAt?.(session.id, each.name, JSON.stringify(each.value));
			}

			close();
		} },
		{ "label": "Save as rule", "className": "save", "title": "Keep it in your policy (.silo/<you>.policy.json): each run sets it each time it gets here", "act": async (rule) => { await rulesSet?.(undefined, rule); close(); } },
		{ "label": "Cancel", "className": "cancel", "title": "Close it, changing nothing", "act": async () => { close(); }, "always": true }
	], catalog);
}

/** A capability stop's question: the call and what it reaches, then the choices — or the rule being made. */
function renderAsk(session: string, ask: CapabilityAsk, element: HTMLElement, redraw: () => void): void {
	const box = document.createElement("div");
	const what = document.createElement("div");
	const callee = document.createElement("span");
	const resource = document.createElement("span");
	const choices = document.createElement("div");
	// A choice made: every button off, the one that made it marked, and the session told.
	const decide = (choice: CapabilityChoice, chosen: HTMLElement): void => {
		for (const other of choices.querySelectorAll("button")) {
			other.disabled = true;
		}

		chosen.classList.add("chosen");
		void choose?.(session, choice).catch((error: unknown) => {
			box.append(Object.assign(document.createElement("div"), { "className": "live-values-ask-error", "textContent": String(error) }));
		});
	};
	const always = ask.resolved ? `${ask.capability} on ${ask.resource}, in your policy (.silo/<you>.policy.json)` : undefined;
	// What to do with the call (a verb), and for how long (its menu): the button itself is this call; ▾ offers this call,
	// every such call this run, or always — kept in your policy (for the resource the call reaches, so only once it's known).
	const split = (verb: string, label: string, lasting: [CapabilityChoice, CapabilityChoice, CapabilityChoice], does: string): HTMLElement => {
		const group = Object.assign(document.createElement("span"), { "className": "live-values-split" });
		// eslint-disable-next-line webawesome/prefer-components -- the workbench realm doesn't load Web Awesome (the shell does)
		const main = Object.assign(document.createElement("button"), { "className": `live-values-choice ${verb}`, "textContent": label, "title": `${does}: this call — and stop here again next time` });
		// eslint-disable-next-line webawesome/prefer-components -- the workbench realm doesn't load Web Awesome (the shell does)
		const more = Object.assign(document.createElement("button"), { "className": `live-values-choice more ${verb}`, "textContent": "▾", "title": `${label}: for how long` });
		const menu = Object.assign(document.createElement("div"), { "className": "live-values-menu", "hidden": true });
		const items: [string, CapabilityChoice, string | undefined][] = [
			["this call", lasting[0], `${does}: this call`],
			["this run", lasting[1], `${does}: every ${ask.capability} call, until this run ends (kept nowhere)`],
			["always", lasting[2], always === undefined ? undefined : `${does}: ${always}`]
		];
		const close = (event: Event): void => {
			if (!group.contains(event.target as Node) || (event instanceof KeyboardEvent && event.key === "Escape")) {
				menu.hidden = true;
				document.removeEventListener("pointerdown", close, true);
				document.removeEventListener("keydown", close, true);
			}
		};

		for (const [text, choice, title] of items) {
			// eslint-disable-next-line webawesome/prefer-components -- the workbench realm doesn't load Web Awesome (the shell does)
			const item = Object.assign(document.createElement("button"), { "className": "live-values-menu-item", "textContent": text, "title": title ?? "Needs the resource the call reaches, which isn't known before the line runs", "disabled": title === undefined });

			item.addEventListener("click", () => {
				menu.hidden = true;
				decide(choice, main);
			});
			menu.append(item);
		}

		main.addEventListener("click", () => { decide(lasting[0], main); });
		more.addEventListener("click", () => {
			menu.hidden = !menu.hidden;

			if (!menu.hidden) {
				document.addEventListener("pointerdown", close, true);
				document.addEventListener("keydown", close, true);
			}
		});
		group.append(main, more, menu);

		return group;
	};

	box.className = `live-values-ask${ask.dangerous ? " dangerous" : ""}`;
	callee.className = "live-values-ask-callee";
	callee.textContent = ask.callee;
	resource.className = ask.resolved ? "live-values-string" : "live-values-ask-unresolved";
	resource.textContent = ask.resolved ? `'${ask.resource}'` : ask.resource;
	what.className = "live-values-ask-what";
	what.title = `${ask.capability}: the policy hasn't allowed it`;
	what.append(callee, " ", resource, Object.assign(document.createElement("span"), { "className": "live-values-ask-capability", "textContent": ` ${ask.capability}` }));
	choices.className = "live-values-choices";
	choices.append(
		split("allow", "Allow", ["allow-once", "allow-run", "allow-always"], "Let it run, for real"),
		split("skip", "Skip", ["skip", "skip-run", "skip-always"], "Don't make it: the run goes on as if it did nothing (the debugger's stand-in answers), the line saying it was skipped"),
		split("deny", "Deny", ["deny", "deny-run", "deny-always"], "Fail it, as a denied call does (EACCES)")
	);

	// eslint-disable-next-line webawesome/prefer-components -- the workbench realm doesn't load Web Awesome (the shell does)
	const rule = Object.assign(document.createElement("button"), { "className": "live-values-choice rule", "textContent": "Rule…", "title": "Make a rule for calls like this one: which ones, and what to do" });

	rule.addEventListener("click", () => {
		rule.disabled = true;
		void openRule(session, ask, () => { making.delete(session); redraw(); }).then((panel) => {
			making.set(session, panel);
			redraw();
		}, (error: unknown) => {
			rule.disabled = false;
			box.append(Object.assign(document.createElement("div"), { "className": "live-values-ask-error", "textContent": String(error) }));
		});
	});
	choices.append(rule);
	box.append(what, making.get(session) ?? choices);
	element.append(box);
}

let styled = false;

/** live-values.css in the page, once — the margin's, and the rule panel's wherever it's shown. */
export function ensureStyled(): void {
	if (!styled) {
		styled = true;
		document.head.append(Object.assign(document.createElement("style"), { "textContent": css }));
	}
}

/** A rule placed in a file (RULES.md: *at*), where it is now: its 1-based lines, and how it was found. */
interface PlacedRule { "whose": "mine" | "shared"; "rule": EditedRule; "status": string; "line": number; "endLine": number }

/** Each file's placed rules as marks, by the document version they were read at; cleared when the rules change. */
const placedRead = new Map<string, { "version": number; "marks": Promise<PaneMark[]> }>();

/** The marks for the rules placed in `document` — beside the first line of the code each is placed at, its sentence
 *  on hover, so a mocked variable or a given result isn't invisible; uncertain where it was found by a weak match. */
function placedMarks(document: vscodeApi.TextDocument): Promise<PaneMark[]> {
	const uri = document.uri.toString();
	const known = placedRead.get(uri);

	if (known?.version === document.version) {
		return known.marks;
	}

	const marks = (async (): Promise<PaneMark[]> => {
		const placed = await rulesPlaced?.(document.uri.path).catch(() => []) ?? [];

		if (placed.length === 0) {
			return [];
		}

		const policy = await import("@brianjenkins94/util/silo/policy");
		const byLine = new Map<number, { "sentences": string[]; "uncertain": boolean }>();

		for (const { whose, rule, status, line, endLine } of placed) {
			const sentence = describeRule(rule, withVariables(policy, variablesOf(rule).map((name) => ({ "name": name, "kind": "" }))));
			const at = byLine.get(line - 1) ?? { "sentences": [], "uncertain": false };
			const lines = endLine > line ? ` (lines ${line}–${endLine})` : "";

			at.sentences.push(`${whose === "mine" ? "My rule" : "A shared rule"}${lines}: ${sentence}${status === "uncertain" ? " — found here by a weak match: open it in the Rules view to confirm or re-place it" : ""}`);
			at.uncertain ||= status === "uncertain";
			byLine.set(line - 1, at);
		}

		return [...byLine].map(([line, { sentences, uncertain }]) => ({ "line": line, "kind": `rule-placed${uncertain ? " uncertain" : ""}`, "title": sentences.join("\n") }));
	})();

	placedRead.set(uri, { "version": document.version, "marks": marks });

	return marks;
}

/** A top-level statement, as tsserver says it (the capabilities plugin's `_statements`): its range, the `//` comment
 *  above it, a title and detail (what it declares or calls), and the types of what it declares. */
interface Statement { "start": number; "end": number; "kind": string; "comment"?: string; "title": string; "detail": string; "declares"?: { "name": string; "type": string | null }[] }

/** A step of the program (PROJECTIONS.md): statements written together, a card around them in the margin. */
interface Step { "fromLine": number; "toLine": number; "title": string; "detail": string; "declares": { "name": string; "type": string | null }[]; "body": boolean }

/** Each file's top-level statements, by the document version they were read at. */
const statementsRead = new Map<string, { "version": number; "statements": Promise<Statement[] | undefined> }>();
/** Each file's tries at its statements while tsserver isn't ready (it isn't, as a file first opens). */
const statementTries = new Map<string, number>();

/** `document`'s top-level statements, from tsserver — undefined when it can't say yet (it's loading the project). */
function statementsOf(document: vscodeApi.TextDocument): Promise<Statement[] | undefined> {
	const uri = document.uri.toString();
	const known = statementsRead.get(uri);

	if (known?.version === document.version) {
		return known.statements;
	}

	const statements = Promise.resolve(api!.commands.executeCommand<{ "body"?: { "statements"?: Statement[] | null } } | undefined>("typescript.tsserverRequest", "_statements", { "file": document.uri })).then((response) => response?.body?.statements ?? undefined, () => undefined);

	statementsRead.set(uri, { "version": document.version, "statements": statements });
	void statements.then((read) => {
		// Not yet: forget it, and try again in a while (a few times).
		if (read === undefined && statementsRead.get(uri)?.statements === statements) {
			statementsRead.delete(uri);

			const tries = statementTries.get(uri) ?? 0;

			if (tries < 5) {
				statementTries.set(uri, tries + 1);
				setTimeout(() => { draw(uri); }, 2000);
			}
		}
	});

	return statements;
}

/** A file's steps: its top-level statements in paragraphs, the way code is written — those with no blank line between
 *  them are one step, a `//` comment above a statement starts one (and titles it), and a function or class is a step of
 *  its own. */
function stepsOf(document: vscodeApi.TextDocument, statements: Statement[]): Step[] {
	const text = document.getText();
	const lines = text.split("\n");
	const steps: (Step & { "end": number; "count": number; "names": string[] })[] = [];
	const bodied = (statement: Statement): boolean => statement.kind === "FunctionDeclaration" || statement.kind === "ClassDeclaration";

	for (const statement of statements) {
		let fromLine = document.positionAt(statement.start).line;

		// Its comment's lines are the step's too.
		while (statement.comment !== undefined && fromLine > 0 && lines[fromLine - 1]!.trim().startsWith("//")) {
			fromLine -= 1;
		}

		const toLine = document.positionAt(statement.end).line;
		const previous = steps.at(-1);
		const together = previous !== undefined && !previous.body && !bodied(statement) && statement.comment === undefined && !/\n[ \t]*\r?\n/u.test(text.slice(previous.end, statement.start));

		if (together) {
			previous.toLine = toLine;
			previous.end = statement.end;
			previous.count += 1;
			previous.declares.push(...statement.declares ?? []);
			previous.names.push(statement.title);
			previous.detail = `${previous.count} statements`;
		} else {
			steps.push({ "fromLine": fromLine, "toLine": toLine, "end": statement.end, "count": 1, "title": statement.comment ?? "", "names": [statement.title], "detail": statement.detail, "declares": [...statement.declares ?? []], "body": bodied(statement) });
		}
	}

	// Untitled, a step is named by what it starts and ends with: `country … total`.
	return steps.map(({ fromLine, toLine, title, names, detail, declares, body }) => ({ "fromLine": fromLine, "toLine": toLine, "title": title !== "" ? title : names.length <= 2 ? names.join(", ") : `${names[0]} … ${names.at(-1)}`, "detail": detail, "declares": declares, "body": body }));
}

/** Whether a step ran, from coverage's marks on its lines (as they're drawn: on the lines their code is on now) — a
 *  function by how often it was called (its body's first mark) — or undefined, with nothing to say. */
function ranOf(step: Step, marks: PaneMark[]): { "kind": string; "text": string } | undefined {
	const covered = marks.filter((mark) => mark.kind.startsWith("coverage-") && step.fromLine <= mark.line && mark.line <= step.toLine);

	if (step.body) {
		const first = covered.filter((mark) => mark.line > step.fromLine).sort((a, b) => a.line - b.line)[0];

		if (first === undefined) {
			return undefined;
		}

		const times = /(\d+)×/u.exec(first.title ?? "")?.[1];

		return first.kind === "coverage-missed" ? { "kind": "missed", "text": "not called" } : { "kind": "ran", "text": times === undefined ? "called" : `called ${times}×` };
	}

	if (covered.length === 0) {
		return undefined;
	}

	return covered.every((mark) => mark.kind === "coverage-ran") ? { "kind": "ran", "text": "ran" } : covered.every((mark) => mark.kind === "coverage-missed") ? { "kind": "missed", "text": "didn't run" } : { "kind": "partial", "text": "partly ran" };
}

/** The last run, step by step (PROJECTIONS.md: the run log): each step that ran, in the order it first did, with its
 *  share of the run's work (the statements run in its code — the same every run) and any time it waited (a timer, on the
 *  event loop's clock) — or undefined, with no profile for these steps. */
interface RunLog { "rows": { "card": number; "title": string; "statements": number; "waited": number }[]; "statements": number; "waited": number }

function runLogOf(steps: Step[], profiled: ProfiledLine[]): RunLog | undefined {
	const rows = steps.map((step, card) => {
		const inside = profiled.filter(({ line }) => step.fromLine <= line && line <= step.toLine);

		return { "card": card, "title": step.title, "statements": inside.reduce((sum, each) => sum + each.statements, 0), "waited": inside.reduce((sum, each) => sum + each.waited, 0), "first": Math.min(...inside.map(({ first }) => first)) };
	}).filter((row) => row.statements > 0).sort((a, b) => a.first - b.first);

	return rows.length === 0 ? undefined : { "rows": rows.map(({ first: _first, ...row }) => row), "statements": rows.reduce((sum, row) => sum + row.statements, 0), "waited": rows.reduce((sum, row) => sum + row.waited, 0) };
}

/** A count, short: 840, 1.2k, 3.4M. */
function shortCount(count: number): string {
	return count < 1000 ? String(count) : count < 1e6 ? `${(count / 1000).toFixed(count < 1e4 ? 1 : 0)}k` : `${(count / 1e6).toFixed(1)}M`;
}

/** The run log, at the file's end: a line per step that ran — its card's number and title, its share of the work, what
 *  it waited — and how the run ended. */
function renderRunLog(log: RunLog, end: RunEnd | undefined, element: HTMLElement): void {
	const div = (className: string, text: string, title?: string): HTMLDivElement => Object.assign(document.createElement("div"), { "className": className, "textContent": text, ...title === undefined ? {} : { "title": title } });
	const span = (className: string, text: string, title?: string): HTMLSpanElement => Object.assign(document.createElement("span"), { "className": className, "textContent": text, ...title === undefined ? {} : { "title": title } });
	const box = div("live-values-runlog", "");
	const ended = end === undefined ? "completed" : end.kind === "crashed" ? `crashed at line ${end.line + 1}` : `stopped at line ${end.line + 1}`;

	box.append(div(`live-values-runlog-head ${end?.kind ?? "completed"}`, `Last run · ${shortCount(log.statements)} statements${log.waited > 0 ? ` · waited ${log.waited}ms` : ""} · ${ended}`, "Work in statements run — the same every run — and waits on the event loop's clock"));

	for (const row of log.rows) {
		const share = Math.round((row.statements / log.statements) * 100);
		const line = div("live-values-runlog-row", "");

		line.append(
			span("live-values-runlog-card", String(row.card + 1)),
			span("live-values-runlog-title", row.title),
			span("live-values-runlog-share", share === 0 ? "<1%" : `${share}%`, `${row.statements} statements`),
			...row.waited > 0 ? [span("live-values-runlog-waited", `waited ${row.waited}ms`)] : []
		);
		box.append(line);
	}

	element.append(box);
}

/** A step's card label: its title, what it is, whether it ran; the types of what it declares on hover. */
function renderStep(step: Step, marks: PaneMark[], element: HTMLElement): void {
	const ran = ranOf(step, marks);

	element.append(
		Object.assign(document.createElement("span"), { "className": "live-values-step-title", "textContent": step.title }),
		...step.detail === "" ? [] : [Object.assign(document.createElement("span"), { "className": "live-values-step-detail", "textContent": step.detail })],
		...ran === undefined ? [] : [Object.assign(document.createElement("span"), { "className": `live-values-step-ran ${ran.kind}`, "textContent": ran.text })]
	);

	if (step.declares.length > 0) {
		element.title = step.declares.map(({ name, type }) => (type === null ? name : `${name}: ${type}`)).join("\n");
	}
}

/** Show a file's values and notes in its margin, or take the margin away when it has neither. */
function draw(uri: string): void {
	void place(uri);
}

/** `items` moved to the lines their code is on now (`anchors`, by each one's `at`), those whose code is gone dropped —
 *  as they are when the file is as it ran, or when there's nothing to place them by. */
async function relocate<T extends { "line": number; "at"?: Range }>(anchors: Anchors | undefined, text: string | undefined, items: T[]): Promise<T[]> {
	if (anchors === undefined || text === undefined || text === anchors.text || items.length === 0) {
		return items;
	}

	const lines = await anchors.lines(text, items.map((item) => item.at ?? [0, 0]));

	return items.flatMap((item, index) => (item.at === undefined || lines[index] === undefined ? [] : [{ ...item, "line": lines[index] }]));
}

/** The file's text as it is now, when it's open. */
function documentText(uri: string): string | undefined {
	return api?.workspace.textDocuments.find((document) => document.uri.toString() === uri)?.getText();
}

async function place(uri: string): Promise<void> {
	const token = (drawing.get(uri) ?? 0) + 1;

	drawing.set(uri, token);

	ensureStyled();

	const session = sessions.get(uri);
	const prose = notes.get(uri) ?? [];
	const text = documentText(uri);
	// Each thing a run put on a line, on the line its code is on now.
	const rows = await relocate(session?.anchors, text, session === undefined ? [] : rowsOf(session.values, session.calls, session.picked));
	const asking = asks.get(uri);
	const [askedAt] = asking === undefined ? [] : await relocate(asking.anchors, text, [asking.ask]);
	const ending = ends.get(uri);
	const [end] = ending === undefined ? [] : await relocate(ending.anchors, text, [ending]);
	// The program's steps, a card around each (PROJECTIONS.md).
	const shown = api?.workspace.textDocuments.find((each) => each.uri.toString() === uri);
	const read = shown === undefined || !CODE.has(shown.languageId) ? undefined : await statementsOf(shown);
	const steps = read === undefined || shown === undefined || shown.getText() !== text ? [] : stepsOf(shown, read);
	const rulesHere = shown === undefined || !CODE.has(shown.languageId) ? [] : await placedMarks(shown);

	// process.argv's row, before any run (or a run that didn't read it yet): on the first line reading it, with the file's
	// stub if it has one — so the inputs can be written first.
	const readsArgv = text !== undefined && /\bprocess\.argv\b/u.test(text);
	const argvAt = !readsArgv || rows.some((row) => row.input === true) ? -1 : text.split("\n").findIndex((each) => /\bprocess\.argv\b/u.test(each));

	// What a rule gives the file's process.argv, read once (then again as it's changed here), for its row.
	if (readsArgv && !givenArgv.has(uri)) {
		givenArgv.set(uri, null);
		void rulesGiven?.(api?.Uri.parse(uri).path ?? "").then((given) => { givenArgv.set(uri, given); draw(uri); }, () => undefined);
	}

	if (drawing.get(uri) !== token) {
		return; // a newer draw is placing
	}

	// (No value of its own: nothing ran. What a rule gives it is beside it.)
	if (argvAt !== -1) {
		rows.push({ "line": argvAt, "label": "process.argv =", "name": "process.argv", "cells": [], "inline": { "text": "", "kind": "argv" }, "group": "0/0", "widths": [], "input": true });
	}

	const last = rows.reduce<Row | undefined>((latest, row) => (latest === undefined || row.line > latest.line ? row : latest), undefined);
	const labelWidths = new Map<string, number>();

	for (const row of rows) {
		const call = row.group.split("/")[0]!;

		labelWidths.set(call, Math.max(labelWidths.get(call) ?? 0, row.label.length));
	}

	const asked = askedAt === undefined ? undefined : { ...asking!, "ask": askedAt };
	// The last run, step by step, at the file's end (after the last card).
	const profiled = profiles.get(uri);
	const runLog = profiled === undefined || steps.length === 0 ? undefined : runLogOf(steps, profiled);
	const logLine = shown === undefined ? 0 : Math.max(shown.lineCount - 1, ...steps.map((step) => step.toLine));
	const entries: PaneEntry[] = [
		// A capability stop's question first on its line: it's what the run waits on.
		...asked === undefined ? [] : [{ "id": "ask", "fromLine": asked.ask.line, "toLine": asked.ask.line }],
		...rows.map((row, index) => ({ "id": `values:${index}`, "fromLine": row.line, "toLine": row.line })),
		// What the bounds left out, under the last line: its cell grows a line for it.
		...last === undefined || session === undefined || session.dropped === 0 ? [] : [{ "id": "values:dropped", "fromLine": last.line, "toLine": last.line }],
		...prose.map((note) => ({ "id": `note:${note.id}`, "fromLine": note.fromLine, "toLine": note.toLine })),
		...runLog === undefined ? [] : [{ "id": "runlog", "fromLine": logLine, "toLine": logLine }]
	];

	columns = new Map();

	const marks: PaneMark[] = [
		...marked.get(uri) ?? [],
		...rulesHere,
		...end === undefined ? [] : [{ "line": end.line, "kind": `run-${end.kind}`, "title": end.kind === "crashed" ? `The last run crashed here: ${end.message ?? "an uncaught error"}` : end.message === undefined ? "The last run was stopped here" : `The last run stopped here: ${end.message}` }]
	];

	margins.set(uri, {
		"file": api?.Uri.parse(uri).path ?? uri,
		"values": rows.map((row) => ({ "line": row.line + 1, "label": row.label, "cells": row.inline === undefined ? row.cells.map((cell) => cell?.text ?? "") : [row.inline.text] })),
		"dropped": session?.dropped ?? 0,
		...asked === undefined ? {} : { "ask": { "line": asked.ask.line + 1, "call": asked.ask.callee, "capability": asked.ask.capability, "resource": asked.ask.resource, "resolved": asked.ask.resolved } },
		...end === undefined ? {} : { "end": { "line": end.line + 1, "kind": end.kind, ...end.message === undefined ? {} : { "message": end.message } } },
		"marks": marks.map((mark) => ({ "line": mark.line + 1, "kind": mark.kind, ...mark.title === undefined ? {} : { "title": mark.title } })),
		"cards": steps.map((step) => ({ "fromLine": step.fromLine + 1, "toLine": step.toLine + 1, "title": step.title })),
		"notes": prose.map((note) => ({ "fromLine": note.fromLine + 1, "toLine": note.toLine + 1, "text": note.text })),
		...runLog === undefined ? {} : { "runLog": runLog }
	});

	// Only a file that isn't code, with nothing in it, goes without.
	if (entries.length === 0 && !open.has(uri) && marks.length === 0 && steps.length === 0) {
		showPane(uri, undefined);

		return;
	}

	showPane(uri, entries, (entry, element) => {
		if (entry.id === "runlog") {
			renderRunLog(runLog!, end, element);

			return undefined;
		}

		if (entry.id.startsWith("step:")) {
			renderStep(steps[Number(entry.id.slice("step:".length))]!, marks, element);

			return undefined;
		}

		if (entry.id === "ask") {
			renderAsk(asked!.session, asked!.ask, element, () => { draw(uri); });

			return undefined;
		}

		if (entry.id === "values:dropped") {
			element.append(Object.assign(document.createElement("div"), { "className": "live-values-dropped", "textContent": `… ${session!.dropped} more values not kept` }));

			return undefined;
		}

		if (entry.id.startsWith("values:")) {
			const row = rows[Number(entry.id.slice("values:".length))]!;

			renderRow(row, labelWidths.get(row.group.split("/")[0]!) ?? 0, session, uri, () => { draw(uri); }, element);

			return undefined;
		}

		const text = prose.find((note) => `note:${note.id}` === entry.id)?.text ?? "";
		let dispose: (() => void) | undefined;
		let gone = false;

		void import("./pane").then(({ renderNote }) => {
			if (!gone) {
				dispose = renderNote(element, text);
			}
		});

		return () => {
			gone = true;
			dispose?.();
		};
	}, marks, steps.map((step, index) => ({ "id": `step:${index}`, "fromLine": step.fromLine, "toLine": step.toLine })));
}

/** Where `uri`'s last run's work went (coverage.ts: tsval's profile, on the lines its statements are on now), for the
 *  run log — or none. */
export function showProfile(uri: string, lines: ProfiledLine[] | undefined): void {
	if (lines === undefined || lines.length === 0) {
		profiles.delete(uri);
	} else {
		profiles.set(uri, lines);
	}

	draw(uri);
}

/** The marks beside `uri`'s lines in the margin's gutter column (coverage's), replacing its last. */
export function showMarks(uri: string, marks: PaneMark[]): void {
	marked.set(uri, marks);
	draw(uri);
}

/** Prose notes beside `uri` (a file URI's string), or none. */
export function showNotes(uri: string, fileNotes: Note[] | undefined): void {
	if (fileNotes === undefined || fileNotes.length === 0) {
		notes.delete(uri);
	} else {
		notes.set(uri, fileNotes);
	}

	draw(uri);
}

/** Keep a margin beside every code file shown, and follow debug sessions' values and capability stops. */
export function installLiveValues(hub: Hub, vscode: typeof vscodeApi): void {
	api = vscode;

	// The pane's views, its tabs on its first line: the margin as it is (values, notes, cards, the run log), and the
	// program's other projections as they come (PROJECTIONS.md) — shown, not yet chosen.
	showPaneViews([
		{ "id": "margin", "label": "Margin", "title": "Values, notes and cards beside the code" },
		{ "id": "cards", "label": "Cards", "title": "Coming: the program as a column of cards, Automator's look (PROJECTIONS.md)", "disabled": true },
		{ "id": "event-sheet", "label": "Event sheet", "title": "Coming: the program as an event sheet's conditions and actions", "disabled": true }
	], "margin", () => undefined);

	const uriOf = (path: string): string => vscode.Uri.file(path).toString();
	/** The text a session ran, as anchors (the same for its values, its question and its end). */
	const anchorsFor = (file: string, source: unknown, session?: Session): Anchors | undefined => session?.anchors ?? (typeof source === "string" ? new Anchors(vscode, file, source) : undefined);
	const follow = (editors: readonly vscodeApi.TextEditor[]): void => {
		for (const editor of editors) {
			const uri = editor.document.uri.toString();

			if (CODE.has(editor.document.languageId) && !open.has(uri)) {
				open.add(uri);
				draw(uri);
			}
		}
	};

	follow(vscode.window.visibleTextEditors);
	vscode.window.onDidChangeVisibleTextEditors(follow);
	// Edited: what a run put on lines moves with its code — drawn again once typing pauses (BABLR re-reads the file).
	const typing = new Map<string, ReturnType<typeof setTimeout>>();

	vscode.workspace.onDidChangeTextDocument((event) => {
		const uri = event.document.uri.toString();

		if (event.contentChanges.length > 0 && (sessions.has(uri) || ends.has(uri) || asks.has(uri) || open.has(uri))) {
			clearTimeout(typing.get(uri));
			typing.set(uri, setTimeout(() => { draw(uri); }, 300));
		}
	});

	// The values drawn ten times a second at most, however often batches come — on a timer, not an animation frame,
	// which a hidden tab never gives (the session's end would wait until it's looked at).
	const pending = new Set<string>();
	let scheduled = false;
	const redraw = (uri: string): void => {
		pending.add(uri);

		if (!scheduled) {
			scheduled = true;
			setTimeout(() => {
				scheduled = false;

				for (const each of pending) {
					draw(each);
				}

				pending.clear();
			}, 100);
		}
	};

	hub.subscribe("values.session.*", (data, envelope) => {
		const { file, source, ...batch } = (data ?? {}) as Partial<LiveBatch> & { "file"?: unknown; "source"?: unknown };
		const id = envelope.subject.slice("values.session.".length);

		if (typeof file !== "string" || !Array.isArray(batch.values)) {
			return;
		}

		const uri = uriOf(file);
		let session = sessions.get(uri);

		// A new session over the file replaces the last one's values, and how the last run ended.
		if (session?.id !== id) {
			session = { "id": id, "values": [], "calls": new Map(), "dropped": 0, "picked": new Map() };
			sessions.set(uri, session);
			ends.delete(uri);
		}

		session.anchors ??= anchorsFor(file, source);
		session.values.push(...batch.values);

		for (const call of batch.calls ?? []) {
			session.calls.set(call.id, call);
		}

		session.dropped = batch.dropped ?? session.dropped;
		redraw(uri);
	});

	// The run's end: how it ended goes on its line. Its values stay — the margin shows the file's last run until the next
	// run of it tells its own (a live run as typing pauses, LIVE-VALUES.md), following its code through edits.
	hub.subscribe("values.ended", (data) => {
		const { session, file, source, end } = (data ?? {}) as { "session"?: unknown; "file"?: unknown; "source"?: unknown; "end"?: RunEnd };

		// How it ended — crashed, or stopped on a line — replacing the last run's; a run that finished clears it.
		if (typeof file === "string") {
			const ran = sessions.get(uriOf(file));

			if (end === undefined) {
				ends.delete(uriOf(file));
			} else {
				ends.set(uriOf(file), { ...end, "anchors": anchorsFor(file, source, ran?.id === session ? ran : undefined) });
			}

			redraw(uriOf(file));
		}

		if (typeof file === "string" && asks.get(uriOf(file))?.session === session) {
			making.delete(session);
			asks.delete(uriOf(file));
			redraw(uriOf(file));
		}
	});

	// A capability stop's question, and its answer back: the session resumes on it.
	const rpc = createRpcClient(hub);

	// What a file's Margin shows (debug-mcp's `margin` tool): the file open in the editor, or `file`, once it's been drawn.
	serve(hub, "margin.state", (args) => {
		const { file } = (args ?? {}) as { "file"?: unknown };
		const path = typeof file === "string" && file !== "" ? (file.startsWith("/") ? file : `/workspace/${file}`) : vscode.window.activeTextEditor?.document.uri.path;
		const state = path === undefined ? undefined : [...margins.values()].find((each) => each.file === path);

		if (state === undefined) {
			throw new Error(path === undefined ? "no file open in the editor — pass one" : `${path} has no Margin drawn — open it in the editor`);
		}

		return state;
	});

	choose = (session, choice, rule, give) => rpc.request(`debug.session.${session}.decide`, { "choice": choice, ...rule === undefined ? {} : { "rule": rule }, ...give === undefined ? {} : { "give": give } }, { "timeoutMs": 24 * 60 * 60_000 });
	recordedOf = async (capability, resource) => rpc.request("capability.recorded", { "capability": capability, "resource": resource }, { "timeoutMs": 10_000 }) as Promise<{ "value": unknown; "at": string } | null>;
	setValueAt = (session, name, value) => rpc.request(`debug.session.${session}.setValue`, { "name": name, "value": value }, { "timeoutMs": 30_000 });
	rulesGiven = async (path) => rpc.request("rules.given", { "program": path, "target": "process.argv" }, { "timeoutMs": 10_000 }) as Promise<Given | null>;
	rulesPlaced = async (path) => rpc.request("rules.placed", { "program": path }, { "timeoutMs": 10_000 }) as Promise<PlacedRule[]>;
	rulesSet = async (previous, rule) => rpc.request("rules.set", { ...previous === undefined ? {} : { "previous": previous }, ...rule === undefined ? {} : { "rule": rule } }, { "timeoutMs": 10_000 });
	// A run answers at its first stop, which can be a while: nobody waits on it here.
	runFile = async (path, cases) => rpc.request("debug.start", { "program": path, "cases": cases }, { "timeoutMs": 24 * 60 * 60_000 });
	// The policy files changed: what a rule gives each file's process.argv is read anew (once the pod has), and whoever
	// lists them is told.
	const watcher = vscode.workspace.createFileSystemWatcher("**/.silo/*policy.json");
	let changed: ReturnType<typeof setTimeout> | undefined;
	const reread = (): void => {
		clearTimeout(changed);
		changed = setTimeout(() => {
			givenArgv.clear();
			placedRead.clear();

			for (const uri of open) {
				draw(uri);
			}

			for (const listener of rulesChanged) {
				listener();
			}
		}, 300);
	};

	watcher.onDidChange(reread);
	watcher.onDidCreate(reread);
	watcher.onDidDelete(reread);
	hub.subscribe("capability.ask", (data) => {
		const { session, file, source, ask } = (data ?? {}) as { "session"?: unknown; "file"?: unknown; "source"?: unknown; "ask"?: CapabilityAsk };

		if (typeof session !== "string" || typeof file !== "string") {
			return;
		}

		const uri = uriOf(file);

		// A new stop, or none: the rule being made at the last one goes.
		making.delete(session);

		if (ask !== undefined) {
			const ran = sessions.get(uri);

			asks.set(uri, { "session": session, "ask": ask, "anchors": anchorsFor(file, source, ran?.id === session ? ran : undefined) });
		} else if (asks.get(uri)?.session === session) {
			asks.delete(uri);
		}

		redraw(uri);
	});
}
