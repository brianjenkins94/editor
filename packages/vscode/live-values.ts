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
 * resumes it. *Allow always* needs the resource the call reaches: offered only when it's known before the line runs.
 *
 * At a stop, a variable's value can be set from its row: click its name, write a literal, Enter — the run goes on with
 * it (`debug.session.<id>.setValue`, as the Variables view's Set Value does), and the value shows in the row as set by
 * hand.
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
import type { PaneEntry, PaneMark } from "@brianjenkins94/monaco-vscode-api/main";
import type { CapabilityAsk, CapabilityChoice, RunEnd } from "./extensions/worker-pod/debug-protocol";
import type { LiveBatch, LiveCall, LiveValue } from "./extensions/worker-pod/live-values";
import type { Range } from "./anchors";
import { Anchors } from "./anchors";
import { createRpcClient } from "@brianjenkins94/hub";
import { showPane } from "@brianjenkins94/monaco-vscode-api/main";
import css from "./live-values.css?raw";

/** A prose note: Markdown on a line span (0-based, inclusive). */
export interface Note { "id": string; "fromLine": number; "toLine": number; "text": string }

/** One line of values as drawn: its label (`mid =`), then a value (`inline`) or a cell per column. */
interface Row { "line": number; "label": string; "name"?: string; "cells": (Cell | undefined)[]; "inline"?: Cell; "group": string; "widths": number[]; "picker"?: Picker; "at"?: Range }

/** A function's calls to pick between, on its first line: which (`function:line`), the one shown (0-based), how many. */
interface Picker { "function": string; "index": number; "count": number }

/** A cell's text and look (`string`, `number`, `boolean`, `branch`). */
interface Cell { "text": string; "kind": string }

/** A session's values, and what's picked in them: a function's call (by `function:line`; none, its latest) and a held
 *  column. */
interface Session { "id": string; "values": LiveValue[]; "calls": Map<number, LiveCall>; "dropped": number; "picked": Map<string, number>; "held"?: string; "anchors"?: Anchors }

/** A column no wider than this many characters; a longer value is cut short, whole on hover. */
const MAX_WIDTH = 24;

/** The latest session's values, per file URI. */
const sessions = new Map<string, Session>();
/** Prose notes, per file URI. */
const notes = new Map<string, Note[]>();
/** Each file's marks for the margin's gutter column (coverage), per file URI. */
const marked = new Map<string, PaneMark[]>();
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
let choose: ((session: string, choice: CapabilityChoice) => Promise<unknown>) | undefined;
/** Sets a variable at a session's stop (set by `installLiveValues`). */
let setValueAt: ((session: string, name: string, value: string) => Promise<unknown>) | undefined;
/** The cells of each column on screen, by group and column: to light a column on every line. */
let columns = new Map<string, HTMLElement[]>();

/** A value's look, by what it reads as. */
function kindOf(value: LiveValue): string {
	if (value.kind === "branch" || value.kind === "set") {
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
		const binds = !named && (only.kind === "bind" || only.kind === "set");
		const label = named ? "" : binds ? `${only.name} =` : only.kind === "return" ? "return" : only.name;
		const group = `${call}/${depth}`;

		if (depth === 0) {
			rows.push({ "line": line, "label": label, ...binds ? { "name": only.name } : {}, "cells": [], "inline": cellOf(inDepth, named), "group": group, "widths": [], ...anchorOf(inDepth) });

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
function renderRow(row: Row, labelWidth: number, session: Session, redraw: () => void, element: HTMLElement): void {
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
					session.picked.delete(key);
				} else {
					session.picked.set(key, index + by);
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

	// A variable's name: click to set its value at the stop (its latest value to start from).
	if (row.name !== undefined) {
		const name = row.name;
		const latest = row.inline?.text ?? row.cells.findLast((each) => each !== undefined)?.text ?? "";

		label.classList.add("editable");
		label.title = `Set ${name} here, at the stop`;
		label.addEventListener("click", () => { editValue(session.id, name, latest, line); });
	}

	if (row.inline !== undefined) {
		line.append(cell(row.inline, "inline"));
	}

	for (const [index, value] of row.cells.entries()) {
		const span = cell(value, "turn");
		const key = `${row.group}#${index}`;

		// eslint-disable-next-line webawesome/no-inline-styles -- dynamic geometry: a column as wide as its widest value
		span.style.width = `${(row.widths[index] ?? 1) + 2}ch`;
		span.classList.toggle("held", session.held === key);
		span.addEventListener("mouseenter", () => { light(key, true); });
		span.addEventListener("mouseleave", () => { light(key, false); });
		span.addEventListener("click", () => { hold(session, key); });
		columns.set(key, [...columns.get(key) ?? [], span]);
		line.append(span);
	}

	element.append(line);
}

/** An inline field after `line`'s label for `name`'s new value: Enter sets it at the session's stop (the run goes on
 *  with it), Escape or leaving it lets it be; what couldn't be set says why. */
function editValue(session: string, name: string, latest: string, line: HTMLElement): void {
	if (line.querySelector(".live-values-input") !== null) {
		return;
	}

	// eslint-disable-next-line webawesome/prefer-components -- the workbench realm doesn't load Web Awesome (the shell does)
	const input = Object.assign(document.createElement("input"), { "className": "live-values-input", "value": latest, "spellcheck": false, "title": "A literal: 'text', 4, true, null, [1, 2], { a: 1 }" });
	const close = (): void => { input.remove(); };

	input.addEventListener("keydown", (event) => {
		if (event.key === "Escape") {
			close();
		} else if (event.key === "Enter") {
			input.disabled = true;
			void setValueAt?.(session, name, input.value).then(close, (error: unknown) => {
				input.disabled = false;
				input.classList.add("refused");
				input.title = error instanceof Error ? error.message : String(error);
			});
		}
	});
	input.addEventListener("blur", () => { if (!input.disabled) { close(); } });
	line.querySelector(".live-values-label")?.after(input);
	input.focus();
	input.select();
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

/** A capability stop's question: the call and what it reaches, then the three choices. */
function renderAsk(session: string, ask: CapabilityAsk, element: HTMLElement): void {
	const box = document.createElement("div");
	const what = document.createElement("div");
	const callee = document.createElement("span");
	const resource = document.createElement("span");
	const choices = document.createElement("div");
	const button = (label: string, choice: CapabilityChoice, title: string, enabled = true): HTMLButtonElement => {
		// eslint-disable-next-line webawesome/prefer-components -- the workbench realm doesn't load Web Awesome (the shell does)
		const each = document.createElement("button");

		each.className = `live-values-choice ${choice}`;
		each.textContent = label;
		each.title = title;
		each.disabled = !enabled;
		each.addEventListener("click", () => {
			for (const other of choices.querySelectorAll("button")) {
				other.disabled = true;
			}

			each.classList.add("chosen");
			void choose?.(session, choice).catch((error: unknown) => {
				box.append(Object.assign(document.createElement("div"), { "className": "live-values-ask-error", "textContent": String(error) }));
			});
		});

		return each;
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
		button("Allow once", "allow-once", "Let this call run, and stop here again next time"),
		button("Allow always", "allow-always", ask.resolved ? `Allow ${ask.capability} on ${ask.resource} in your policy (.silo/<you>.policy.json)` : "Needs the resource the call reaches, which isn't known before the line runs", ask.resolved),
		button("Deny", "deny", "Fail this call, as the policy would")
	);
	box.append(what, choices);
	element.append(box);
}

let styled = false;

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

	if (!styled) {
		styled = true;
		document.head.append(Object.assign(document.createElement("style"), { "textContent": css }));
	}

	const session = sessions.get(uri);
	const prose = notes.get(uri) ?? [];
	const text = documentText(uri);
	// Each thing a run put on a line, on the line its code is on now.
	const rows = await relocate(session?.anchors, text, session === undefined ? [] : rowsOf(session.values, session.calls, session.picked));
	const asking = asks.get(uri);
	const [askedAt] = asking === undefined ? [] : await relocate(asking.anchors, text, [asking.ask]);
	const ending = ends.get(uri);
	const [end] = ending === undefined ? [] : await relocate(ending.anchors, text, [ending]);

	if (drawing.get(uri) !== token) {
		return; // a newer draw is placing
	}

	const last = rows.reduce<Row | undefined>((latest, row) => (latest === undefined || row.line > latest.line ? row : latest), undefined);
	const labelWidths = new Map<string, number>();

	for (const row of rows) {
		const call = row.group.split("/")[0]!;

		labelWidths.set(call, Math.max(labelWidths.get(call) ?? 0, row.label.length));
	}

	const asked = askedAt === undefined ? undefined : { ...asking!, "ask": askedAt };
	const entries: PaneEntry[] = [
		// A capability stop's question first on its line: it's what the run waits on.
		...asked === undefined ? [] : [{ "id": "ask", "fromLine": asked.ask.line, "toLine": asked.ask.line }],
		...rows.map((row, index) => ({ "id": `values:${index}`, "fromLine": row.line, "toLine": row.line })),
		// What the bounds left out, under the last line: its cell grows a line for it.
		...last === undefined || session === undefined || session.dropped === 0 ? [] : [{ "id": "values:dropped", "fromLine": last.line, "toLine": last.line }],
		...prose.map((note) => ({ "id": `note:${note.id}`, "fromLine": note.fromLine, "toLine": note.toLine }))
	];

	columns = new Map();

	const marks: PaneMark[] = [
		...marked.get(uri) ?? [],
		...end === undefined ? [] : [{ "line": end.line, "kind": `run-${end.kind}`, "title": end.kind === "crashed" ? `The last run crashed here: ${end.message ?? "an uncaught error"}` : "The last run was stopped here" }]
	];

	// Only a file that isn't code, with nothing in it, goes without.
	if (entries.length === 0 && !open.has(uri) && marks.length === 0) {
		showPane(uri, undefined);

		return;
	}

	showPane(uri, entries, (entry, element) => {
		if (entry.id === "ask") {
			renderAsk(asked!.session, asked!.ask, element);

			return undefined;
		}

		if (entry.id === "values:dropped") {
			element.append(Object.assign(document.createElement("div"), { "className": "live-values-dropped", "textContent": `… ${session!.dropped} more values not kept` }));

			return undefined;
		}

		if (entry.id.startsWith("values:")) {
			const row = rows[Number(entry.id.slice("values:".length))]!;

			renderRow(row, labelWidths.get(row.group.split("/")[0]!) ?? 0, session!, () => { draw(uri); }, element);

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
	}, marks);
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

		if (event.contentChanges.length > 0 && (sessions.has(uri) || ends.has(uri) || asks.has(uri))) {
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

	// Live as long as the session: gone when it ends.
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
			asks.delete(uriOf(file));
			redraw(uriOf(file));
		}

		if (typeof file === "string" && sessions.get(uriOf(file))?.id === session) {
			sessions.delete(uriOf(file));
			redraw(uriOf(file));
		}
	});

	// A capability stop's question, and its answer back: the session resumes on it.
	const rpc = createRpcClient(hub);

	choose = (session, choice) => rpc.request(`debug.session.${session}.decide`, { "choice": choice }, { "timeoutMs": 24 * 60 * 60_000 });
	setValueAt = (session, name, value) => rpc.request(`debug.session.${session}.setValue`, { "name": name, "value": value }, { "timeoutMs": 30_000 });
	hub.subscribe("capability.ask", (data) => {
		const { session, file, source, ask } = (data ?? {}) as { "session"?: unknown; "file"?: unknown; "source"?: unknown; "ask"?: CapabilityAsk };

		if (typeof session !== "string" || typeof file !== "string") {
			return;
		}

		const uri = uriOf(file);

		if (ask !== undefined) {
			const ran = sessions.get(uri);

			asks.set(uri, { "session": session, "ask": ask, "anchors": anchorsFor(file, source, ran?.id === session ? ran : undefined) });
		} else if (asks.get(uri)?.session === session) {
			asks.delete(uri);
		}

		redraw(uri);
	});
}
