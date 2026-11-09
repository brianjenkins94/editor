/**
 * Live values (RUNTIME-EVIDENCE.md, *Live values*): what a run computed, beside the code in the Margin, Bret Victor's binary
 * search. Every debugger tells them as the run contract's custom events (`values` as they grow, `ended`).
 *
 * Each file's last runs are kept (RUNTIME-EVIDENCE.md, *Runs kept, as balls*), a ball each at the Margin's top: with their
 * values and how they ended, here and on this machine (runs.ts), identified by their code, so a reformat run again is the
 * same run counted. A click shows that run's. The latest is shown until another's picked, and a finished one rolls its ball
 * down the gutter through the lines it went.
 *
 * A function called more than once shows one call: its latest, or the one picked on its first line (`‹ 3/5 ›`). Columns
 * line up down a call: every line at the same loop depth has the same columns, each as wide as its widest value, so a turn
 * reads straight down; hovering one lights it on every line, a click holds it. What the bounds left out is said under the
 * last line.
 *
 * Everything is placed by its range in the text that ran, so it follows its code through edits and reformats (pane-views,
 * through BABLR's spans). What else the Margin showed at `full-editor` (Mock…, Rule…, cards) comes back with those features.
 */
import type { CoverageEvent, EffectsEvent, EndedEvent, LiveCall, LivePlace, LiveValue, RunEnd, ValuesEvent } from "@brianjenkins94/editor-api";
import type { Range } from "@brianjenkins94/editor-api/anchors";
import type { PaneAction, PaneAt, PaneCell, PaneContent, PaneItem, PaneMark, PanePath, PaneRun } from "@brianjenkins94/editor-api/pane";
import type { ObservedExtension } from "@brianjenkins94/editor-api/runtime";
import type { RunTrace } from "@brianjenkins94/util/silo/traces";
import { Anchors } from "@brianjenkins94/editor-api/anchors";
import { annotations } from "@brianjenkins94/editor-api/annotations";
import { declarationsHolding, inputOf, spanAround, traceKey } from "@brianjenkins94/util/silo/traces";
import * as vscode from "vscode";
import { blobOid, keepRun, keptRuns } from "./runs";

/** One line of values as drawn: its label (`mid =`), then a value (`inline`) or a cell per column. */
interface Row { "line": number; "label": string; "name"?: string; "cells": (Cell | undefined)[]; "inline"?: Cell; "group": string; "widths": number[]; "picker"?: Picker; "at"?: Range; "unmade"?: string }

/** A function's calls to pick between, on its first line: which (`function:line`), the one shown (0-based), how many. */
interface Picker { "function": string; "index": number; "count": number }

/** A cell's text and look (`string`, `number`, `boolean`, `branch`). */
interface Cell { "text": string; "kind": string }

/** A run's values in a file, and what's picked in them: a function's call (by `function:line`; none, its latest) and a
 *  held column. How it ended (`done`, and `end` if that was short), when it started, how many runs alike it stands for and
 *  what identifies it (`key`); `now`, where it is while it goes. */
interface Session { "id": string; "values": LiveValue[]; "calls": Map<number, LiveCall>; "dropped": number; "picked": Map<string, number>; "held"?: string; "anchors"?: Anchors; "at": number; "done"?: boolean; "end"?: RunEnd; "count": number; "key"?: string; "now"?: LivePlace; "live"?: true }

/** A column no wider than this many characters; a longer value is cut short, whole on hover. */
const MAX_WIDTH = 24;

/** How many runs of a file are kept. */
const KEPT = 8;
/** How many of a run's steps its ball rolls through, at most. */
const MAX_PATH = 400;
/** How long a run goes before its ball follows it as it goes: a shorter one's rolls once it's finished. */
const FOLLOW_AFTER = 1000;

/** The run shown, per file URI: the latest, or one picked from those kept. */
const sessions = new Map<string, Session>();
/** Each file's runs kept, oldest first. */
const kept = new Map<string, Session[]>();
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
	// A call the run didn't make there, skipped or given what it returned last: `<capability> <resource>`.
	const unmade = lineValues.findLast((value) => value.kind === "skip" || value.kind === "given")?.value;
	const notMade = unmade === undefined ? {} : { "unmade": unmade };

	if (depth === 0) {
		return { "line": line, "label": label, ...binds ? { "name": only.name } : {}, "cells": [], "inline": cellOf(inDepth, named), "group": group, "widths": [], ...anchorOf(inDepth), ...notMade };
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
		...anchorOf(inDepth),
		...notMade
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

/** A row's *Pin…* and *Rule…*, for a call a live run didn't make: what runs after an edit do with it (pin.ts). None for a run someone
 *  was watching, which skipped a call because they said so at its stop. */
function unmadeActions(uri: string, row: Row, session: Session): PaneAction[] {
	if (session.live !== true || row.unmade === undefined || row.unmade === "") {
		return [];
	}

	const [capability, ...rest] = row.unmade.split(" ");
	const resource = rest.join(" ");

	return [
		{ "title": "Pin…", "command": "margin.pin", "arguments": [uri, capability, resource, row.line], "tooltip": "Keep a value past runs saw here: runs after an edit are given it" },
		{ "title": "Rule…", "command": "margin.unattended", "arguments": [uri, capability, resource], "tooltip": "What runs after an edit, which nobody's watching, do with this call" }
	];
}

function rowItem(uri: string, row: Row, index: number, session: Session): PaneItem {
	const { picker } = row;
	const unmade = unmadeActions(uri, row, session);
	const step = (by: number, text: string, title: string): PaneCell => {
		const to = picker === undefined ? -1 : picker.index + by;

		return { "text": text, "title": title, ...picker !== undefined && to >= 0 && to < picker.count ? { "command": { "title": title, "command": "margin.pick", "arguments": [uri, picker.function, to, picker.count] } } : {} };
	};

	return {
		"id": `values:${String(index)}`,
		"at": placeOf(session.anchors, row.line, row.at),
		...unmade.length === 0 ? {} : { "actions": unmade, "tone": "question" as const },
		"content": {
			...row.label === "" ? {} : { "label": row.label },
			...picker === undefined ? {} : { "lead": [step(-1, "‹", "The call before"), { "text": `${String(picker.index + 1)}/${String(picker.count)}`, "title": `Call ${String(picker.index + 1)} of ${String(picker.count)}` }, step(1, "›", "The call after")] },
			...row.inline === undefined ? {} : { "value": { "text": row.inline.text, "kind": cellKind(row.inline.kind) } },
			"cells": row.cells.map((cell, column) => (cell === undefined ? { "text": "" } : { "text": cell.text, "kind": cellKind(cell.kind), "picked": session.held === `${row.group}#${String(column)}`, "command": { "title": "Hold", "command": "margin.hold", "arguments": [uri, `${row.group}#${String(column)}`] } }))
		}
	};
}

/** What the Margin shows of `uri`'s run, for an agent (`margin.state`): each row on the line it's on now (1-based), its label
 *  and its value or a column per turn; how the run went; and how many values the bounds left out. A row whose code is gone isn't. */
export async function valuesState(uri: string, text: string | undefined): Promise<{ "run"?: string; "rows": { "line": number; "label": string; "value"?: string; "cells"?: string[]; "unmade"?: string }[]; "dropped": number }> {
	const session = sessions.get(uri);

	if (session === undefined) {
		return { "rows": [], "dropped": 0 };
	}

	const rows = rowsOf(session.values, session.calls, session.picked);
	const lines = session.anchors === undefined || text === undefined || text === session.anchors.text ? undefined : await session.anchors.lines(text, rows.map((row) => row.at ?? [0, 0]));
	const run = stateOf(session);

	return {
		...run === undefined ? { "run": "running" } : { "run": HOW[run] ?? run },
		"rows": rows.flatMap((row, index) => {
			const line = lines === undefined ? row.line : row.at === undefined ? undefined : lines[index];

			return line === undefined ? [] : [{ "line": line + 1, "label": row.label, ...row.inline === undefined ? { "cells": row.cells.map((cell) => cell?.text ?? "") } : { "value": row.inline.text }, ...row.unmade === undefined ? {} : { "unmade": row.unmade }}];
		}),
		"dropped": session.dropped
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

/** Whether the run shown has a value of `name` on `line` (0-based): the Margin's showing it, so it can be mocked. */
export const valueNamed = (uri: string, line: number, name: string): boolean => sessions.get(uri)?.values.some((value) => value.line === line && value.name === name) === true;

/** The gutter's mark for how the run shown ended short: ✕ where it crashed, ■ where it was stopped. */
export function endMarks(uri: string): PaneMark[] {
	const session = sessions.get(uri);
	const ending = session?.end;

	if (ending === undefined) {
		return [];
	}

	const title = ending.kind === "crashed" ? `The last run crashed here: ${ending.message ?? "an uncaught error"}` : ending.message === undefined ? "The last run was stopped here" : `The last run stopped here: ${ending.message}`;

	return [{ "at": placeOf(session?.anchors, ending.line, ending.at), "kind": ending.kind, "title": title }];
}

/** How a run ended, as its ball's colour; none while it's running. */
function stateOf(run: Session): PaneRun["state"] {
	if (run.done !== true) {
		return undefined;
	}

	if (run.end === undefined) {
		return "ran";
	}

	return run.end.kind === "crashed" ? "crashed" : "stopped";
}

const HOW: Record<string, string> = { "ran": "ran to its end", "crashed": "crashed", "stopped": "stopped short" };

/** Where a run went: a step a value, in the order it ran them, the same line twice running counted once. */
function pathOf(run: Session): PanePath {
	const at: PaneAt[] = [];
	let line: number | undefined;

	for (const value of run.values) {
		if (value.line !== line && at.length < MAX_PATH) {
			({ line } = value);
			at.push(placeOf(run.anchors, value.line, value.at));
		}
	}

	return { "id": run.id, "at": at };
}

/** A file's runs kept, a ball each, and where the one shown went (its ball rolls along it) or, going for a while, is. */
export function runsShown(uri: string): Pick<PaneContent, "runs" | "path"> {
	const shown = sessions.get(uri);
	const runs = (kept.get(uri) ?? []).map((run): PaneRun => {
		const state = stateOf(run);
		const alike = run.count > 1 ? ` (${String(run.count)} runs alike)` : "";

		return {
			"id": run.id,
			"title": `${new Date(run.at).toLocaleTimeString()} — ${state === undefined ? "running" : HOW[state] ?? ""}, ${String(run.values.length)} value${run.values.length === 1 ? "" : "s"}${alike}`,
			...state === undefined ? {} : { "state": state },
			"picked": run === shown,
			"command": { "title": "Show this run", "command": "margin.pickRun", "arguments": [uri, run.id] }
		};
	});
	let path: PanePath | undefined;

	if (shown?.done === true) {
		path = pathOf(shown);
	} else if (shown?.now !== undefined && Date.now() - shown.at >= FOLLOW_AFTER) {
		path = { "id": shown.id, "at": [placeOf(shown.anchors, shown.now.line, shown.now.at)], "live": true };
	}

	return { ...runs.length === 0 ? {} : { "runs": runs }, ...path === undefined ? {} : { "path": path } };
}

/** `file`'s `[line, character]` positions as offsets. */
function offsetsIn(text: string): (position: [number, number]) => number {
	const starts = [0];

	for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
		starts.push(at + 1);
	}

	return ([line, character]) => (starts[line] ?? text.length) + character;
}

/** A file's runs from this machine, once it's shown and none are here yet: the latest shown. */
async function restoreRuns(uri: string): Promise<boolean> {
	if ((kept.get(uri) ?? []).length > 0) {
		return false;
	}

	const { path } = vscode.Uri.parse(uri);
	const traces = await keptRuns(vscode.workspace.asRelativePath(vscode.Uri.parse(uri), false));
	const runs = traces.filter((trace) => trace.source !== undefined).map((trace): Session => ({
		"id": trace.id,
		"values": trace.values.map((value) => ({ "line": value.line, "name": value.name, "value": value.value ?? "‹value›", "kind": value.kind as LiveValue["kind"], "call": value.call, "turns": value.turns, ...value.at === undefined ? {} : { "at": value.at } })),
		"calls": new Map(trace.calls.map((call) => [call.id, call])),
		"dropped": 0,
		"picked": new Map(),
		"anchors": new Anchors(vscode, path, trace.source ?? ""),
		"at": Date.parse(trace.at),
		"done": true,
		...trace.end === undefined ? {} : { "end": trace.end },
		"count": trace.count,
		"key": traceKey(trace)
	}));

	// (a run that came meanwhile is newer: it stays shown)
	if (runs.length === 0 || (kept.get(uri) ?? []).length > 0) {
		return false;
	}

	kept.set(uri, runs);
	sessions.set(uri, runs.at(-1)!);

	return true;
}

/** `run`, finished, as a trace: identified by the top-level declarations it ran (BABLR's spans of the text it ran), each
 *  value by the span around it. With no spans (text BABLR can't parse), by its text. */
async function traceOf(uri: string, run: Session, inputs: string[], executed: [[number, number], [number, number]][]): Promise<RunTrace> {
	const source = run.anchors?.text ?? "";
	const answer = await annotations(vscode.commands).spans(source).catch(() => undefined);
	const spans = answer !== undefined && "value" in answer ? answer.value : undefined;
	const offsetOf = offsetsIn(source);
	const ran: [number, number][] = [
		...executed.map(([start, end]): [number, number] => [offsetOf(start), offsetOf(end)]),
		...run.values.flatMap((value) => (value.at === undefined ? [] : [value.at])),
		...[...run.calls.values()].flatMap((call) => (call.at === undefined ? [] : [call.at]))
	];
	const declarations = spans === undefined ? undefined : declarationsHolding(spans, ran);

	return {
		"id": run.id,
		"file": vscode.workspace.asRelativePath(vscode.Uri.parse(uri), false),
		"oid": await blobOid(source),
		...declarations === undefined || declarations.length === 0 ? {} : { "declarations": declarations },
		"trigger": "you",
		"at": new Date(run.at).toISOString(),
		"count": 1,
		...run.end === undefined ? {} : { "end": { "kind": run.end.kind, "line": run.end.line, ...run.end.at === undefined ? {} : { "at": run.end.at }, ...run.end.message === undefined ? {} : { "message": run.end.message } } },
		"inputs": [...new Set(inputs)].toSorted(),
		"values": run.values.map((value) => {
			const span = spans === undefined || value.at === undefined ? undefined : spanAround(spans, value.at[0], value.at[1]);

			return { "line": value.line, "name": value.name, "kind": value.kind, "call": value.call, "turns": value.turns, "value": value.value, ...value.at === undefined ? {} : { "at": value.at }, ...span === undefined ? {} : { "span": span.id } };
		}),
		"calls": [...run.calls.values()],
		"source": source
	};
}

/** Keep each debug run's values and end, `redraw` a file's Margin as they change. */
export function installValues(context: vscode.ExtensionContext, log: ObservedExtension["log"] | undefined, redraw: (uri: string) => void, answered: (session: string) => void): void {
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
	/** Each live run going, by its session and file: only a finished one replaces what the Margin shows, so an edit that stops one
	 *  leaves the last run's. */
	const going = new Map<string, Session>();
	/** `run` of `uri`, kept and shown: the file's latest. */
	const show = (uri: string, run: Session): void => {
		kept.set(uri, [...kept.get(uri) ?? [], run].slice(-KEPT));
		sessions.set(uri, run);
	};
	/** `id`'s run of `uri`, or a new one: the file's latest, unless it's live. */
	const runOf = (uri: string, id: string, live: boolean): Session => {
		const found = kept.get(uri)?.find((each) => each.id === id) ?? going.get(`${id} ${uri}`);

		if (found !== undefined) {
			return found;
		}

		const run: Session = { "id": id, "values": [], "calls": new Map(), "dropped": 0, "picked": new Map(), "at": Date.now(), "count": 1, ...live ? { "live": true } : {} };

		if (live) {
			going.set(`${id} ${uri}`, run);
		} else {
			show(uri, run);
		}

		return run;
	};
	const anchorsFrom = (run: Session, file: string, source: string | undefined): void => {
		if (run.anchors === undefined && typeof source === "string") {
			run.anchors = new Anchors(vscode, file, source);
		}
	};
	const valuesCame = (id: string, live: boolean, { file, source, replace, ...batch }: ValuesEvent): void => {
		const uri = uriOf(file);
		const run = runOf(uri, id, live);

		// A report of every value so far (a preview's recorded stops), in place of the last: of the version that ran last,
		// which a hot update may have changed.
		if (replace === true) {
			run.values = [];
			run.calls.clear();
			run.anchors = undefined;
		}

		anchorsFrom(run, file, source);
		run.values.push(...batch.values);
		run.now = batch.now ?? batch.values.at(-1) ?? run.now;

		for (const call of batch.calls) {
			run.calls.set(call.id, call);
		}

		run.dropped = batch.dropped;
		batchedAt.set(uri, Date.now());
		// Running again past a capability stop: its question's answered, by whoever answered it. (A value set at the stop is
		// told too, and the run's still waiting there.)
		if (replace !== true && batch.values.some((value) => value.kind !== "set")) {
			answered(id);
		}

		soon(uri);
	};
	// The run's end: how it ended goes on its line. (A run that told no values here, a file that didn't parse say, is a run
	// all the same.)
	const endedCame = (id: string, live: boolean, { file, source, end }: EndedEvent): void => {
		const uri = uriOf(file);
		const run = runOf(uri, id, live);

		anchorsFrom(run, file, source);
		run.done = true;

		if (going.delete(`${id} ${uri}`)) {
			show(uri, run);
		}

		if (end !== undefined) {
			run.end = end;
		}

		soon(uri);
	};
	/** What each session read from outside, from its effects: its values may hold it. */
	const inputsOf = new Map<string, string[]>();
	/** The statements each session ran, by file: what its code is. */
	const executedOf = new Map<string, Map<string, [[number, number], [number, number]][]>>();
	/** A finished session's runs, kept: the same as one kept already is that one, counted again, and shown as the latest. */
	const keepSession = async (id: string): Promise<void> => {
		const inputs = inputsOf.get(id) ?? [];
		const executed = executedOf.get(id);

		inputsOf.delete(id);
		executedOf.delete(id);

		for (const [uri, runs] of kept) {
			const run = runs.find((each) => each.id === id);

			if (run?.done === true && run.anchors !== undefined) {
				const trace = await traceOf(uri, run, inputs, executed?.get(vscode.Uri.parse(uri).path) ?? []);
				const key = traceKey(trace);
				const now = kept.get(uri) ?? [];
				const same = now.find((each) => each !== run && each.key === key);

				if (same === undefined) {
					run.key = key;
				} else {
					same.count += 1;
					same.at = run.at;
					kept.set(uri, [...now.filter((each) => each !== run && each !== same), same]);

					if (sessions.get(uri) === run) {
						sessions.set(uri, same);
					}
				}

				redraw(uri);
				await keepRun(trace, KEPT);
			}
		}
	};
	const keeping = async (id: string): Promise<void> => {
		const keep = async (): Promise<void> => keepSession(id);

		await (log === undefined ? keep() : log.span("editor.extensions.margin.values.keep", {}, keep)).catch((error: unknown) => {
			log?.warn("a run couldn't be kept", { "error": String(error) });
		});
	};
	/** A code file shown: its runs from this machine. */
	const follow = (editors: readonly vscode.TextEditor[]): void => {
		for (const { document } of editors) {
			if (document.uri.scheme === "file") {
				const uri = document.uri.toString();

				void restoreRuns(uri).then((restored) => {
					if (restored) {
						redraw(uri);
					}
				}, () => undefined);
			}
		}
	};

	follow(vscode.window.visibleTextEditors);

	/** A change to what a file's run shows (`value` its URI), drawn. */
	const changing = (change: (session: Session, key: string, ...rest: unknown[]) => void) => (value: unknown, key: unknown, ...rest: unknown[]): void => {
		const session = typeof value === "string" ? sessions.get(value) : undefined;

		if (session !== undefined && typeof key === "string") {
			change(session, key, ...rest);
			redraw(value as string);
		}
	};

	context.subscriptions.push(
		vscode.window.onDidChangeVisibleTextEditors(follow),
		// A run kept to show, and how it ended.
		vscode.commands.registerCommand("margin.pickRun", (value: unknown, id: unknown) => {
			const uri = String(value);
			const run = kept.get(uri)?.find((each) => each.id === id);

			if (run === undefined) {
				throw new Error("that run isn't kept any more");
			}

			sessions.set(uri, run);
			redraw(uri);
		}),
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
			const live = session.configuration["__live"] === true;

			if (event === "values") {
				valuesCame(session.id, live, body as ValuesEvent);
			} else if (event === "ended") {
				told.add(session.id);
				endedCame(session.id, live, body as EndedEvent);
			} else if (event === "effects") {
				// (what came in: a call made, or given a result, not one skipped or denied)
				inputsOf.set(session.id, (body as EffectsEvent).effects.filter((effect) => effect.how === "made" || effect.how === "given").map((effect) => inputOf(effect.capability, effect.resource)));
			} else if (event === "coverage") {
				const executed = new Map<string, [[number, number], [number, number]][]>();

				for (const report of [body as CoverageEvent, ...(body as CoverageEvent).files ?? []]) {
					executed.set(report.file, report.statements.filter((statement) => statement.count > 0).map((statement) => [statement.start, statement.end]));
				}

				executedOf.set(session.id, executed);
			}
		}),
		// A debugger that tells no `ended`: the program's run ends with its session. A live run that didn't finish is gone.
		vscode.debug.onDidTerminateDebugSession((session) => {
			const { program } = session.configuration;
			const live = session.configuration["__live"] === true;

			if (!told.delete(session.id) && typeof program === "string" && !live) {
				endedCame(session.id, false, { "file": program });
			}

			for (const key of going.keys()) {
				if (key.startsWith(`${session.id} `)) {
					going.delete(key);
				}
			}

			// (after every event it told: its values, end and effects)
			void keeping(session.id);
		})
	);
}
