/**
 * Live values (RUNTIME-EVIDENCE.md, *Live values*): what a run computed, beside the code in the Margin, Bret Victor's binary
 * search. Every debugger tells them as the run contract's custom events (`values` as they grow, `ended`); this keeps each
 * file's latest run's, and how it ended short, until the file's next run tells its own.
 *
 * A function called more than once shows one call: its latest, or the one picked on its first line (`‹ 3/5 ›`). Columns
 * line up down a call: every line at the same loop depth has the same columns, each as wide as its widest value, so a turn
 * reads straight down; hovering one lights it on every line, a click holds it. What the bounds left out is said under the
 * last line.
 *
 * Everything is placed by its range in the text that ran, so it follows its code through edits and reformats (pane-views,
 * through BABLR's spans). What else the Margin showed at `full-editor` (Mock…, Rule…, cards, past runs) comes back with
 * those features.
 */
import type { EndedEvent, LiveCall, LiveValue, RunEnd, ValuesEvent } from "@brianjenkins94/editor-api";
import type { Range } from "@brianjenkins94/editor-api/anchors";
import type { PaneAt, PaneCell, PaneItem, PaneMark } from "@brianjenkins94/editor-api/pane";
import { Anchors } from "@brianjenkins94/editor-api/anchors";
import * as vscode from "vscode";

/** One line of values as drawn: its label (`mid =`), then a value (`inline`) or a cell per column. */
interface Row { "line": number; "label": string; "name"?: string; "cells": (Cell | undefined)[]; "inline"?: Cell; "group": string; "widths": number[]; "picker"?: Picker; "at"?: Range }

/** A function's calls to pick between, on its first line: which (`function:line`), the one shown (0-based), how many. */
interface Picker { "function": string; "index": number; "count": number }

/** A cell's text and look (`string`, `number`, `boolean`, `branch`). */
interface Cell { "text": string; "kind": string }

/** A run's values in a file, and what's picked in them: a function's call (by `function:line`; none, its latest) and a
 *  held column. */
interface Session { "id": string; "values": LiveValue[]; "calls": Map<number, LiveCall>; "dropped": number; "picked": Map<string, number>; "held"?: string; "anchors"?: Anchors }

/** How a run ended short, and the text it ran. */
type Ending = RunEnd & { "anchors"?: Anchors };

/** A column no wider than this many characters; a longer value is cut short, whole on hover. */
const MAX_WIDTH = 24;

/** The latest run's values, per file URI. */
const sessions = new Map<string, Session>();
/** How each file's last run ended short, per file URI. */
const ends = new Map<string, Ending>();
/** When each file's latest batch of values came (inline values wait for a stop's to come in). */
const batchedAt = new Map<string, number>();
/** The sessions that told their end themselves. */
const told = new Set<string>();

/** A value's look, by what it reads as. */
function kindOf(value: LiveValue): string {
	if (value.kind === "branch" || value.kind === "set" || value.kind === "skip" || value.kind === "given") {
		return value.kind;
	}

	if (/^['"`]/u.test(value.value)) {
		return "string";
	}

	if (/^-?\d/u.test(value.value)) {
		return "number";
	}

	return value.value === "true" || value.value === "false" ? "boolean" : "";
}

/** What a value reads as in a cell: a branch its arm, anything else its preview. */
function textOf(value: LiveValue): string {
	if (value.kind !== "branch") {
		return value.value;
	}

	return value.value === "0" ? "then" : "else";
}

/** A line's values in one turn, as one cell: the value, or `name = value` each when the line binds more than one name. */
function cellOf(values: LiveValue[], named: boolean): Cell {
	const last = new Map<string, LiveValue>();

	for (const value of values) {
		last.delete(value.name);
		last.set(value.name, value);
	}

	const shown = [...last.values()];

	return { "text": shown.map((value) => (named ? `${value.name} = ${textOf(value)}` : textOf(value))).join(", "), "kind": shown.length === 1 ? kindOf(shown[0]) : "" };
}

/** Turns as a column's key, and in order: outermost loop first, numerically. */
function compareTurns(first: string, second: string): number {
	const left = first.split(".").map(Number);
	const right = second.split(".").map(Number);

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

/** A row's label: none for a line that binds more than one name, `name =` for one it binds, else `return` or the name. */
function labelOf(only: LiveValue, named: boolean, binds: boolean): string {
	if (named) {
		return "";
	}

	if (binds) {
		return `${only.name} =`;
	}

	return only.kind === "return" ? "return" : only.name;
}

/** A line's row, from its values (`ordered`: each call and loop depth's columns): at the top level its value inline,
 *  in a loop a cell per turn. */
function rowOfLine(line: number, lineValues: LiveValue[], ordered: Map<string, string[]>): Row {
	// A line belongs to one call; its loop depth is its deepest value's.
	const { call } = lineValues.at(-1);
	const depth = Math.max(...lineValues.map((value) => value.turns.length));
	const inDepth = lineValues.filter((value) => value.turns.length === depth);
	const names = [...new Set(inDepth.map((value) => value.name))];
	const named = names.length > 1;
	const [only] = inDepth;
	const binds = !named && (only.kind === "bind" || only.kind === "set");
	const label = labelOf(only, named, binds);
	const group = `${call}/${depth}`;
	if (depth === 0) {
		return { "line": line, "label": label, ...binds ? { "name": only.name } : {}, "cells": [], "inline": cellOf(inDepth, named), "group": group, "widths": [], ...anchorOf(inDepth) };
	}

	const turns = ordered.get(group) ?? [];

	return {
		"line": line,
		"label": label,
		...binds ? { "name": only.name } : {},
		"cells": turns.map((turn) => {
			const inTurn = inDepth.filter((value) => value.turns.join(".") === turn);

			return inTurn.length === 0 ? undefined : cellOf(inTurn, named);
		}),
		"group": group,
		"widths": [],
		...anchorOf(inDepth)
	};
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

		return [key, { "call": ordered[index], "index": index, "count": ordered.length }];
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

	for (const [line, lineValues] of [...byLine].toSorted(([leftLine], [rightLine]) => leftLine - rightLine)) {
		rows.push(rowOfLine(line, lineValues, ordered));
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

/** A cell's look, as the contract names it: the kinds it knows; any other, plain. */
const CELL_KINDS = new Set(["number", "string", "boolean", "object", "error", "undefined", "branch", "set", "skip", "given"]);

function cellKind(kind: string | undefined): PaneCell["kind"] {
	return kind !== undefined && CELL_KINDS.has(kind) ? kind as PaneCell["kind"] : undefined;
}

/** Where something a run put on its line `line` is: its range `at` in the text that ran, followed to the file as it is by
 *  the editor (pane-views), or with nothing to follow it from, that line. */
function placeOf(anchors: Anchors | undefined, line: number, at: Range | undefined): PaneAt {
	return anchors !== undefined && at !== undefined ? { "ran": { "source": anchors.text, "start": at[0], "end": at[1] } } : { "lines": [line, line] };
}

function rowItem(uri: string, row: Row, index: number, session: Session): PaneItem {
	const { picker } = row;
	const step = (by: number, text: string, title: string): PaneCell => {
		const to = picker === undefined ? -1 : picker.index + by;

		return { "text": text, "title": title, ...picker !== undefined && to >= 0 && to < picker.count ? { "command": { "title": title, "command": "margin.pick", "arguments": [uri, picker.function, to, picker.count] } } : {} };
	};

	return {
		"id": `values:${String(index)}`,
		"at": placeOf(session.anchors, row.line, row.at),
		"content": {
			...row.label === "" ? {} : { "label": row.label },
			...picker === undefined ? {} : { "lead": [step(-1, "‹", "The call before"), { "text": `${String(picker.index + 1)}/${String(picker.count)}`, "title": `Call ${String(picker.index + 1)} of ${String(picker.count)}` }, step(1, "›", "The call after")] },
			...row.inline === undefined ? {} : { "value": { "text": row.inline.text, "kind": cellKind(row.inline.kind) } },
			"cells": row.cells.map((cell, column) => (cell === undefined ? { "text": "" } : { "text": cell.text, "kind": cellKind(cell.kind), "picked": session.held === `${row.group}#${String(column)}`, "command": { "title": "Hold", "command": "margin.hold", "arguments": [uri, `${row.group}#${String(column)}`] } }))
		}
	};
}

/** What the Margin shows of `uri`'s last run: a row per line that has values, and what the bounds left out. */
export function valueItems(uri: string, text: string | undefined): PaneItem[] {
	const session = sessions.get(uri);

	if (session === undefined) {
		return [];
	}

	// (a row with nothing to follow it by, once the file's changed from what ran, is gone)
	const moved = session.anchors !== undefined && text !== undefined && text !== session.anchors.text;
	const rows = rowsOf(session.values, session.calls, session.picked).filter((row) => !moved || row.at !== undefined);
	const last = rows.at(-1);

	return [
		...rows.map((row, index) => rowItem(uri, row, index, session)),
		...last === undefined || session.dropped === 0 ? [] : [{ "id": "values:dropped", "at": placeOf(session.anchors, last.line, last.at), "content": { "markdown": `… ${String(session.dropped)} more values not kept` }, "tone": "info" } satisfies PaneItem]
	];
}

/** The gutter's mark for how `uri`'s last run ended short: ✕ where it crashed, ■ where it was stopped. */
export function endMarks(uri: string): PaneMark[] {
	const ending = ends.get(uri);

	if (ending === undefined) {
		return [];
	}

	const title = ending.kind === "crashed" ? `The last run crashed here: ${ending.message ?? "an uncaught error"}` : ending.message === undefined ? "The last run was stopped here" : `The last run stopped here: ${ending.message}`;

	return [{ "at": placeOf(ending.anchors, ending.line, ending.at), "kind": ending.kind, "title": title }];
}

/** Keep each debug run's values and end, `redraw` a file's Margin as they change. */
export function installValues(context: vscode.ExtensionContext, redraw: (uri: string) => void, answered: (session: string) => void): void {
	const uriOf = (path: string): string => vscode.Uri.file(path).toString();
	// The values drawn ten times a second at most, however often batches come: on a timer, not an animation frame, which a
	// hidden tab never gives.
	const pending = new Set<string>();
	let scheduled = false;
	const soon = (uri: string): void => {
		pending.add(uri);

		if (!scheduled) {
			scheduled = true;
			setTimeout(() => {
				scheduled = false;

				for (const each of pending) {
					redraw(each);
				}

				pending.clear();
			}, 100);
		}
	};
	const valuesCame = (id: string, { file, source, ...batch }: ValuesEvent): void => {
		const uri = uriOf(file);
		let session = sessions.get(uri);

		// A new run of the file replaces the last one's values, and how it ended.
		if (session?.id !== id) {
			session = { "id": id, "values": [], "calls": new Map(), "dropped": 0, "picked": new Map() };
			sessions.set(uri, session);
			ends.delete(uri);
		}

		session.anchors ??= typeof source === "string" ? new Anchors(vscode, file, source) : undefined;
		session.values.push(...batch.values);

		for (const call of batch.calls) {
			session.calls.set(call.id, call);
		}

		session.dropped = batch.dropped;
		batchedAt.set(uri, Date.now());
		// Running again past a capability stop: its question's answered, by whoever answered it.
		answered(id);
		soon(uri);
	};
	// The run's end: how it ended goes on its line, and its values stay until the file's next run tells its own.
	const endedCame = (id: string, { file, source, end }: EndedEvent): void => {
		const uri = uriOf(file);
		const ran = sessions.get(uri);

		if (end === undefined) {
			ends.delete(uri);
		} else {
			// (a run that told no values here: a file that didn't parse, say, has only its end, and the last run's values are stale)
			if (ran?.id !== id) {
				sessions.delete(uri);
			}

			ends.set(uri, { ...end, ...ran?.id === id ? ran.anchors === undefined ? {} : { "anchors": ran.anchors } : typeof source === "string" ? { "anchors": new Anchors(vscode, file, source) } : {} });
		}

		soon(uri);
	};
	/** A change to what a file's run shows (`value` its URI), drawn. */
	const changing = (change: (session: Session, key: string, ...rest: unknown[]) => void) => (value: unknown, key: unknown, ...rest: unknown[]): void => {
		const session = typeof value === "string" ? sessions.get(value) : undefined;

		if (session !== undefined && typeof key === "string") {
			change(session, key, ...rest);
			redraw(value as string);
		}
	};

	context.subscriptions.push(
		// A function's call to show.
		vscode.commands.registerCommand("margin.pick", changing((session, key, index, count) => {
			if (index === Number(count) - 1) {
				session.picked.delete(key);
			} else {
				session.picked.set(key, Number(index));
			}
		})),
		// A click holds a column lit; another lets it go.
		vscode.commands.registerCommand("margin.hold", changing((session, key) => {
			session.held = session.held === key ? undefined : key;
		})),
		// At a stop, the values as VS Code's own inline values too (the debugger's documented contract for values beside the
		// code): each row's latest at the end of its line, for the session VS Code stopped in. VS Code asks as it stops, while
		// the stop's last values may still be on their way, so it's answered once they're in.
		vscode.languages.registerInlineValuesProvider({ "scheme": "file" }, {
			"provideInlineValues": async (document, viewport) => {
				const uri = document.uri.toString();
				const stopped = vscode.debug.activeStackItem?.session.id ?? vscode.debug.activeDebugSession?.id;

				for (let waited = 0; waited < 2000 && (sessions.get(uri)?.id !== stopped || Date.now() - (batchedAt.get(uri) ?? 0) < 200); waited += 50) {
					await new Promise((resolve) => {
						setTimeout(resolve, 50);
					});
				}

				const session = sessions.get(uri);

				if (stopped === undefined || session?.id !== stopped) {
					return [];
				}

				const rows = rowsOf(session.values, session.calls, session.picked);
				const text = document.getText();
				const lines = session.anchors === undefined || text === session.anchors.text ? undefined : await session.anchors.lines(text, rows.map((row) => row.at ?? [0, 0]));

				return rows.flatMap((row, index) => {
					const line = lines === undefined ? row.line : row.at === undefined ? undefined : lines[index];
					const latest = row.inline?.text ?? row.cells.findLast((cell) => cell !== undefined && cell.text !== "")?.text;

					return latest === undefined || line === undefined || line < viewport.start.line || line > viewport.end.line || line >= document.lineCount ? [] : [new vscode.InlineValueText(document.lineAt(line).range, row.label === "" ? latest : `${row.label} ${latest}`)];
				});
			}
		}),
		vscode.debug.onDidReceiveDebugSessionCustomEvent(({ session, event, body }) => {
			if (event === "values") {
				valuesCame(session.id, body as ValuesEvent);
			} else if (event === "ended") {
				told.add(session.id);
				endedCame(session.id, body as EndedEvent);
			}
		}),
		// A debugger that tells no `ended`: the program's run ends with its session.
		vscode.debug.onDidTerminateDebugSession((session) => {
			const { program } = session.configuration;

			if (!told.delete(session.id) && typeof program === "string") {
				endedCame(session.id, { "file": program });
			}
		})
	);
}
