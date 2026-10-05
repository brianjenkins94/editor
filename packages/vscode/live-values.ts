/**
 * Live values, as notes (LIVE-VALUES.md, step 6): a debug session's values — what each line bound, returned or chose,
 * a column per turn of the loop around it — beside the code in the component's notes margin (`showPane`), Bret Victor's
 * binary search. The debug adapter publishes them on the pod hub (`values.session.<id>` as they grow, `values.ended`);
 * this keeps the latest session's per file, shows them while the session lives, and takes them away when it ends.
 *
 * A function called more than once shows its latest call. Columns line up down a call: every line at the same loop
 * depth has the same columns, each as wide as its widest value, so a turn reads straight down; hovering one lights it on
 * every line. The margin also carries prose notes (`showNotes`, rendered by pane.tsx): both go in one `showPane` per
 * file, values first on a line.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { PaneEntry } from "@brianjenkins94/monaco-vscode-api/main";
import type { LiveBatch, LiveCall, LiveValue } from "./extensions/worker-pod/live-values";
import { showPane } from "@brianjenkins94/monaco-vscode-api/main";
import css from "./live-values.css?raw";

/** A prose note: Markdown on a line span (0-based, inclusive). */
export interface Note { "id": string; "fromLine": number; "toLine": number; "text": string }

/** One line of values as drawn: its label (`mid =`), then a value (`inline`) or a cell per column. */
interface Row { "line": number; "label": string; "cells": (Cell | undefined)[]; "inline"?: Cell; "group": string; "widths": number[] }

/** A cell's text and look (`string`, `number`, `boolean`, `branch`). */
interface Cell { "text": string; "kind": string }

interface Session { "id": string; "values": LiveValue[]; "calls": Map<number, LiveCall>; "dropped": number }

/** A column no wider than this many characters; a longer value is cut short, whole on hover. */
const MAX_WIDTH = 24;

/** The latest session's values, per file URI. */
const sessions = new Map<string, Session>();
/** Prose notes, per file URI. */
const notes = new Map<string, Note[]>();
/** The cells of each column on screen, by group and column: to light a column on every line. */
let columns = new Map<string, HTMLElement[]>();

/** A value's look, by what it reads as. */
function kindOf(value: LiveValue): string {
	if (value.kind === "branch") {
		return "branch";
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

/** A session's rows: each function's latest call (and the top level), a row per line that has values. */
export function rowsOf(values: LiveValue[], calls: Map<number, LiveCall>): Row[] {
	const latest = new Map<string, number>();

	for (const call of calls.values()) {
		const key = `${call.name}:${call.line}`;

		latest.set(key, Math.max(latest.get(key) ?? -1, call.id));
	}

	const shownCalls = new Set([0, ...latest.values()]);
	const byLine = new Map<number, LiveValue[]>();

	for (const value of values.filter((candidate) => shownCalls.has(candidate.call))) {
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
		const label = named ? "" : only.kind === "bind" ? `${only.name} =` : only.kind === "return" ? "return" : only.name;
		const group = `${call}/${depth}`;

		if (depth === 0) {
			rows.push({ "line": line, "label": label, "cells": [], "inline": cellOf(inDepth, named), "group": group, "widths": [] });

			continue;
		}

		const turns = ordered.get(group) ?? [];

		rows.push({ "line": line, "label": label, "cells": turns.map((turn) => {
			const inTurn = inDepth.filter((value) => value.turns.join(".") === turn);

			return inTurn.length === 0 ? undefined : cellOf(inTurn, named);
		}), "group": group, "widths": [] });
	}

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

/** A row's element: its label (as wide as its call's widest), then its value or its columns. */
function renderRow(row: Row, labelWidth: number, element: HTMLElement): void {
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
		span.addEventListener("mouseenter", () => { light(key, true); });
		span.addEventListener("mouseleave", () => { light(key, false); });
		columns.set(key, [...columns.get(key) ?? [], span]);
		line.append(span);
	}

	element.append(line);
}

function light(key: string, on: boolean): void {
	for (const cell of columns.get(key) ?? []) {
		cell.classList.toggle("lit", on);
	}
}

let styled = false;

/** Show a file's values and notes in its margin, or take the margin away when it has neither. */
function draw(uri: string): void {
	if (!styled) {
		styled = true;
		document.head.append(Object.assign(document.createElement("style"), { "textContent": css }));
	}

	const session = sessions.get(uri);
	const prose = notes.get(uri) ?? [];
	const rows = session === undefined ? [] : rowsOf(session.values, session.calls);
	const labelWidths = new Map<string, number>();

	for (const row of rows) {
		const call = row.group.split("/")[0]!;

		labelWidths.set(call, Math.max(labelWidths.get(call) ?? 0, row.label.length));
	}

	const entries: PaneEntry[] = [
		...rows.map((row) => ({ "id": `values:${row.line}`, "fromLine": row.line, "toLine": row.line })),
		...prose.map((note) => ({ "id": `note:${note.id}`, "fromLine": note.fromLine, "toLine": note.toLine }))
	];

	columns = new Map();

	if (entries.length === 0) {
		showPane(uri, undefined);

		return;
	}

	showPane(uri, entries, (entry, element) => {
		if (entry.id.startsWith("values:")) {
			const row = rows.find((candidate) => `values:${candidate.line}` === entry.id)!;

			renderRow(row, labelWidths.get(row.group.split("/")[0]!) ?? 0, element);

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
	});
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

/** Follow debug sessions' values: `uriOf` turns a session's program path into its file URI. */
export function installLiveValues(hub: Hub, uriOf: (path: string) => string): void {
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
		const { file, ...batch } = (data ?? {}) as Partial<LiveBatch> & { "file"?: unknown };
		const id = envelope.subject.slice("values.session.".length);

		if (typeof file !== "string" || !Array.isArray(batch.values)) {
			return;
		}

		const uri = uriOf(file);
		let session = sessions.get(uri);

		// A new session over the file replaces the last one's values.
		if (session?.id !== id) {
			session = { "id": id, "values": [], "calls": new Map(), "dropped": 0 };
			sessions.set(uri, session);
		}

		session.values.push(...batch.values);

		for (const call of batch.calls ?? []) {
			session.calls.set(call.id, call);
		}

		session.dropped = batch.dropped ?? session.dropped;
		redraw(uri);
	});

	// Live as long as the session: gone when it ends.
	hub.subscribe("values.ended", (data) => {
		const { session, file } = (data ?? {}) as { "session"?: unknown; "file"?: unknown };

		if (typeof file === "string" && sessions.get(uriOf(file))?.id === session) {
			sessions.delete(uriOf(file));
			redraw(uriOf(file));
		}
	});
}
