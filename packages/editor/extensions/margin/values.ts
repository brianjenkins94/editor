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

interface Row { "line": number; "label": string; "name"?: string; "cells": (Cell | undefined)[]; "inline"?: Cell; "group": string; "widths": number[]; "picker"?: Picker; "at"?: Range; "unmade"?: string }

interface Picker { "function": string; "index": number; "count": number }

interface Cell { "text": string; "kind": string }

interface Session { "id": string; "values": LiveValue[]; "calls": Map<number, LiveCall>; "dropped": number; "picked": Map<string, number>; "held"?: string; "anchors"?: Anchors; "at": number; "done"?: boolean; "end"?: RunEnd; "count": number; "key"?: string; "now"?: LivePlace; "live"?: true }

const MAX_WIDTH = 24;

const KEPT = 8;
const MAX_PATH = 400;
const FOLLOW_AFTER = 1000;

const sessions = new Map<string, Session>();
const kept = new Map<string, Session[]>();
const batchedAt = new Map<string, number>();
const told = new Set<string>();

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

function textOf(value: LiveValue): string {
	if (value.kind !== "branch") {
		return value.value;
	}

	return value.value === "0" ? "then" : "else";
}

function cellOf(values: LiveValue[], named: boolean): Cell {
	const last = new Map<string, LiveValue>();

	for (const value of values) {
		last.delete(value.name);
		last.set(value.name, value);
	}

	const shown = [...last.values()];

	return { "text": shown.map((value) => (named ? `${value.name} = ${textOf(value)}` : textOf(value))).join(", "), "kind": shown.length === 1 ? kindOf(shown[0]) : "" };
}

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

function anchorOf(values: LiveValue[]): { "at"?: Range } {
	const at = values.find((value) => value.at !== undefined)?.at;

	return at === undefined ? {} : { "at": at };
}

function homed(values: LiveValue[]): LiveValue[] {
	return values.map((value, index) => {
		if (value.kind !== "set") {
			return value;
		}

		const home = values.slice(0, index).findLast((other) => other.kind !== "set" && other.name === value.name && other.call === value.call);

		return home === undefined ? value : { ...value, "line": home.line, "turns": home.turns.length === 0 ? [] : value.turns, ...home.at === undefined ? {} : { "at": home.at } };
	});
}

function labelOf(only: LiveValue, named: boolean, binds: boolean): string {
	if (named) {
		return "";
	}

	if (binds) {
		return `${only.name} =`;
	}

	return only.kind === "return" ? "return" : only.name;
}

function rowOfLine(line: number, lineValues: LiveValue[], ordered: Map<string, string[]>): Row {
	const { call } = lineValues.at(-1);
	const depth = Math.max(...lineValues.map((value) => value.turns.length));
	const inDepth = lineValues.filter((value) => value.turns.length === depth);
	const names = [...new Set(inDepth.map((value) => value.name))];
	const named = names.length > 1;
	const [only] = inDepth;
	const binds = !named && (only.kind === "bind" || only.kind === "set");
	const label = labelOf(only, named, binds);
	const group = `${call}/${depth}`;
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

	for (const group of new Set(rows.map((row) => row.group))) {
		const members = rows.filter((row) => row.group === group);
		const widths = (members[0]?.cells ?? []).map((_, index) => Math.min(MAX_WIDTH, Math.max(1, ...members.map((row) => row.cells[index]?.text.length ?? 0))));

		for (const row of members) {
			row.widths = widths;
		}
	}

	return rows;
}

const CELL_KINDS = new Set(["number", "string", "boolean", "object", "error", "undefined", "branch", "set", "skip", "given"]);

function cellKind(kind: string | undefined): PaneCell["kind"] {
	return kind !== undefined && CELL_KINDS.has(kind) ? kind as PaneCell["kind"] : undefined;
}

function placeOf(anchors: Anchors | undefined, line: number, at: Range | undefined): PaneAt {
	return anchors !== undefined && at !== undefined ? { "ran": { "source": anchors.text, "start": at[0], "end": at[1] } } : { "lines": [line, line] };
}

function unmadeActions(uri: string, row: Row, session: Session): PaneAction[] {
	if (session.live !== true || row.unmade === undefined || row.unmade === "") {
		return [];
	}

	const [capability, ...rest] = row.unmade.split(" ");
	const resource = rest.join(" ");

	return [
		{ "title": "Pin…", "command": "margin.pin", "arguments": [uri, capability, resource, row.line, ...session.anchors === undefined ? [] : [session.anchors.text]], "tooltip": "Keep a value past runs saw here: runs after an edit are given it" },
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

export function valueItems(uri: string, text: string | undefined): PaneItem[] {
	const session = sessions.get(uri);

	if (session === undefined) {
		return [];
	}

	const moved = session.anchors !== undefined && text !== undefined && text !== session.anchors.text;
	const rows = rowsOf(session.values, session.calls, session.picked).filter((row) => !moved || row.at !== undefined);
	const last = rows.at(-1);

	return [
		...rows.map((row, index) => rowItem(uri, row, index, session)),
		...last === undefined || session.dropped === 0 ? [] : [{ "id": "values:dropped", "at": placeOf(session.anchors, last.line, last.at), "content": { "markdown": `… ${String(session.dropped)} more values not kept` }, "tone": "info" } satisfies PaneItem]
	];
}

export const valueNamed = (uri: string, line: number, name: string): boolean => sessions.get(uri)?.values.some((value) => value.line === line && value.name === name) === true;

export function endMarks(uri: string): PaneMark[] {
	const session = sessions.get(uri);
	const ending = session?.end;

	if (ending === undefined) {
		return [];
	}

	const title = ending.kind === "crashed" ? `The last run crashed here: ${ending.message ?? "an uncaught error"}` : ending.message === undefined ? "The last run was stopped here" : `The last run stopped here: ${ending.message}`;

	return [{ "at": placeOf(session?.anchors, ending.line, ending.at), "kind": ending.kind, "title": title }];
}

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

function offsetsIn(text: string): (position: [number, number]) => number {
	const starts = [0];

	for (let at = text.indexOf("\n"); at !== -1; at = text.indexOf("\n", at + 1)) {
		starts.push(at + 1);
	}

	return ([line, character]) => (starts[line] ?? text.length) + character;
}

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

	if (runs.length === 0 || (kept.get(uri) ?? []).length > 0) {
		return false;
	}

	kept.set(uri, runs);
	sessions.set(uri, runs.at(-1)!);

	return true;
}

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

export function installValues(context: vscode.ExtensionContext, log: ObservedExtension["log"] | undefined, redraw: (uri: string) => void, answered: (session: string) => void): void {
	const uriOf = (path: string): string => vscode.Uri.file(path).toString();
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
	const going = new Map<string, Session>();
	const show = (uri: string, run: Session): void => {
		kept.set(uri, [...kept.get(uri) ?? [], run].slice(-KEPT));
		sessions.set(uri, run);
	};
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
		if (replace !== true && batch.values.some((value) => value.kind !== "set")) {
			answered(id);
		}

		soon(uri);
	};
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
	const inputsOf = new Map<string, string[]>();
	const executedOf = new Map<string, Map<string, [[number, number], [number, number]][]>>();
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

	const changing = (change: (session: Session, key: string, ...rest: unknown[]) => void) => (value: unknown, key: unknown, ...rest: unknown[]): void => {
		const session = typeof value === "string" ? sessions.get(value) : undefined;

		if (session !== undefined && typeof key === "string") {
			change(session, key, ...rest);
			redraw(value as string);
		}
	};

	context.subscriptions.push(
		vscode.window.onDidChangeVisibleTextEditors(follow),
		vscode.commands.registerCommand("margin.pickRun", (value: unknown, id: unknown) => {
			const uri = String(value);
			const run = kept.get(uri)?.find((each) => each.id === id);

			if (run === undefined) {
				throw new Error("that run isn't kept any more");
			}

			sessions.set(uri, run);
			redraw(uri);
		}),
		vscode.commands.registerCommand("margin.pick", changing((session, key, index, count) => {
			if (index === Number(count) - 1) {
				session.picked.delete(key);
			} else {
				session.picked.set(key, Number(index));
			}
		})),
		vscode.commands.registerCommand("margin.hold", changing((session, key) => {
			session.held = session.held === key ? undefined : key;
		})),
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
				inputsOf.set(session.id, (body as EffectsEvent).effects.filter((effect) => effect.how === "made" || effect.how === "given").map((effect) => inputOf(effect.capability, effect.resource)));
			} else if (event === "coverage") {
				const executed = new Map<string, [[number, number], [number, number]][]>();

				for (const report of [body as CoverageEvent, ...(body as CoverageEvent).files ?? []]) {
					executed.set(report.file, report.statements.filter((statement) => statement.count > 0).map((statement) => [statement.start, statement.end]));
				}

				executedOf.set(session.id, executed);
			}
		}),
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

			void keeping(session.id);
		})
	);
}
