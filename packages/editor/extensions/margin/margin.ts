/**
 * Live values, as notes (RUNTIME-EVIDENCE.md, *Live values*): a debug session's values — what each line bound, returned or chose,
 * a column per turn of the loop around it — beside the code in the pane's Margin, Bret Victor's binary search. The
 * Margin is a pane view like any extension's (ARCHITECTURE.md, *Extension points* 4): this answers `margin.paneView` with its content
 * as data (marginOf), each thing placed by its range in the text that ran, and core's pane draws it; its buttons and
 * cells run `margin.*` commands. Every debugger tells its values as the run contract's custom events (`values` as they
 * grow, `ended`, a capability stop's `ask`) — read here as any extension reads them; this keeps the latest session's
 * per file, shows them while the session lives, and takes them away when it ends.
 *
 * A function called more than once shows one call — its latest, or the one picked on its first line (`‹ 3/5 ›`).
 * Columns line up down a call: every line at the same loop depth has the same columns, each as wide as its widest
 * value, so a turn reads straight down; hovering one lights it on every line, a click holds it. The cursor's line opens
 * up, its values whole (the margin's cell lit at the cursor: pane.ts). What the bounds left out is said under the last
 * line.
 *
 * A capability stop asks on its line too (RUNTIME-EVIDENCE.md, *Capability decisions, on the line*): what the call would do — `writeFileSync '/workspace/out.txt'` — and
 * Allow once*, *Allow always*, *Deny*, the choice sent back to the session (the bridge's `editor.capability.decide`), which
 * resumes it. *Allow this run* lets every call of the capability through until the run ends (a loop asks once), kept
 * nowhere. *Allow always* needs the resource the call reaches — known even when the line computes it (the worker runs a
 * fork of the stop to the call to see it).
 * Rule…* opens the rule editor in the Rule view (core's `editor.rules.edit`, RUNNING.md, *Rules*), prefilled with the
 * call — *capability is*, *resource is*, *then allow* — to widen or narrow it (*resource matches* a glob) and apply it
 * Just this once*, or *Save as rule* in my policy, the run going on as it decides. Or *give* the call's *result*
 * instead of it (RUNNING.md, *A call's result*) — starting from what it returned the last time it ran for real, when
 * that's recorded (editor-api's `recordedResult`).
 *
 * A variable's row has *Mock…* on hover (RUNTIME-EVIDENCE.md, *Mocking a value*): the rule editor, in the Rule view, prefilled *program is
 * <this file>*, *at* <this statement> (a span reference, followed through edits), *then set* it to the value the run
 * had; the run's other variables are targets too. *Just this once* sets it at this stop and the run goes on with it
 * (the bridge's `editor.debug.setValue`, as the Variables view's Set Value does); *Save as rule* keeps it, and each run sets it
 * each time it gets there, without stopping (the adapter places the rule; the worker sets it after the statement runs).
 * process.argv's row — on the first line that
 * reads it, there before any run — has *Mock…*: the rule editor, in the Rule view, prefilled *program is <this file>*, *then give
 * process.argv* the run's arguments, each value a run of its own; *Run* runs the file with them, once; *Save as rule*
 * keeps it in my policy, and every run of the file is given them (`silo.rules.set`; the row shows what a rule gives,
 * `silo.rules.given`: the capabilities extension's).
 *
 * The margin is always open beside a JavaScript or TypeScript file, with or without anything to show: it's the file's
 * runtime column — coverage in its gutter column, left of the code (`showMarks`, from coverage.ts), values,
 * decisions. In that column too, how the last run ended short: ✕ on the line it crashed on (the error on hover), ■ on
 * the one it was stopped at — until the file runs again.
 *
 * Everything a run put on a line follows its code through edits and cosmetic changes (a reformat, a reindent): each is
 * anchored by its node's range in the text that ran (editor-api's anchors, BABLR spans) and drawn where that code is
 * now; what lost its code goes.
 *
 * A preview's recorded stops come the same way: `values` on its run's `production` session (the bridge's), each report
 * every hit so far (`replace`).
 */
import type { AskEvent, CapabilityChoice, CoverageEvent, EffectsEvent, EndedEvent, ImpureWrite, LiveCall, LivePlace, LiveValue, RunEnd, TestsEvent, ValuesEvent } from "@brianjenkins94/editor-api";
import type { Range } from "@brianjenkins94/editor-api/anchors";
import type { PaneMark as ContentMark, PaneAction, PaneAt, PaneCell, PaneContent, PaneGroup, PaneItem, PanePath, PaneRun } from "@brianjenkins94/editor-api/pane";
import type { EditAnswer, EditButton, EditRequest } from "@brianjenkins94/editor-api/rules";
import type { ObservedExtension } from "@brianjenkins94/editor-api/runtime";
import type { Rule } from "@brianjenkins94/util/silo/policy";
import type { Determined } from "@brianjenkins94/util/silo/purity";
import type { RunTrace, Span } from "@brianjenkins94/util/silo/traces";
import type { LineMark as PaneMark, ProfiledLine } from "./coverage";
import { Anchors } from "@brianjenkins94/editor-api/anchors";
import { annotations } from "@brianjenkins94/editor-api/annotations";
import { failureText } from "@brianjenkins94/editor-api/failures";
import { refreshPane } from "@brianjenkins94/editor-api/pane";
import { recordedResult } from "@brianjenkins94/editor-api/policy";
import { argvRunsOf, decisionOf, resultOf } from "@brianjenkins94/editor-api/rules";
import { POLICY_GLOB } from "@brianjenkins94/util/silo/layout";
import { determinedAt } from "@brianjenkins94/util/silo/purity";
import { declarationsHolding, inputOf, mayRead, spanAround, traceKey } from "@brianjenkins94/util/silo/traces";
import * as vscode from "vscode";
import { parseInputs } from "./inputs";
import { blobOid, keepRun, keptRuns } from "./runs";

/** A capability stop's question, as the margin shows it on its line (the run contract's `ask`, its file and text apart). */
type CapabilityAsk = Omit<AskEvent, "file" | "source">;

/** One line of values as drawn: its label (`mid =`), then a value (`inline`) or a cell per column. */
interface Row { "line": number; "label": string; "name"?: string; "cells": (Cell | undefined)[]; "inline"?: Cell; "group": string; "widths": number[]; "picker"?: Picker; "at"?: Range; "input"?: boolean; "unmade"?: string }

/** What a rule gives a file's process.argv: the rule, and its values, each a run's arguments. */
interface Given { "rule": Rule; "values": string[][] }

/** A function's calls to pick between, on its first line: which (`function:line`), the one shown (0-based), how many. */
interface Picker { "function": string; "index": number; "count": number }

/** A cell's text and look (`string`, `number`, `boolean`, `branch`). */
interface Cell { "text": string; "kind": string }

/** A session's values, and what's picked in them: a function's call (by `function:line`; none, its latest) and a held
 *  column. */
interface Session { "id": string; "values": LiveValue[]; "calls": Map<number, LiveCall>; "dropped": number; "picked": Map<string, number>; "held"?: string; "anchors"?: Anchors; "at"?: number; "done"?: boolean; "end"?: RunEnd & { "anchors"?: Anchors }; "live"?: boolean; "count"?: number; "key"?: string; "marks"?: PaneMark[]; "profile"?: ProfiledLine[]; "now"?: LivePlace }

/** A column no wider than this many characters; a longer value is cut short, whole on hover. */
const MAX_WIDTH = 24;

/** What a file's Margin shows, as plain data (the `margin_state` tool, through `margin.state`): set each time it's
 *  drawn. Lines are 1-based, as an agent reads code. */
interface MarginState {
	"file": string;
	"values": { "line": number; "label": string; "cells": string[] }[];
	"dropped": number;
	"ask"?: { "line": number; "call": string; "capability": string; "resource": string; "resolved": boolean };
	"end"?: { "line": number; "kind": string; "message"?: string };
	"marks": { "line": number; "kind": string; "title"?: string }[];
	"cards": { "fromLine": number; "toLine": number; "title": string; "purity"?: string; "flagged"?: string }[];
	"runLog"?: RunLog;
	/** The runs kept of the file, oldest first: each one's id, whether it's the one shown, and how it ended (none while it goes). */
	"runs": { "id": string; "picked": boolean; "state"?: PaneRun["state"] }[];
}

/** Each drawn file's MarginState, by URI. */
const margins = new Map<string, MarginState>();

/** When each file's latest batch of values came (inline values wait for a stop's to come in). */
const batchedAt = new Map<string, number>();

/** The session shown, per file URI: the latest, or one picked from those kept — its values kept once it ends, until the
 *  next session of the file tells its own. */
const sessions = new Map<string, Session>();
/** Each file's runs kept, oldest first, a ball each at the Margin's top (RUNNING.md, unattended runs): their values,
 *  and how each ended — the record of what things were in that run. */
const kept = new Map<string, Session[]>();
/** How many runs of a file are kept. */
const KEPT = 8;
/** The live runs going (RUNTIME-EVIDENCE.md, *Live runs*): nobody's watching them, so what they didn't make has *Rule…* for such runs. */
const liveSessions = new Set<string>();
/** What each session read from outside, from its effects (a call made, or given a result): its values may hold a secret. */
const inputsOf = new Map<string, string[]>();
/** The statements each session executed, by file (its coverage, [line, character] each): what its code is. */
const executedOf = new Map<string, Map<string, [[number, number], [number, number]][]>>();
/** Each file's functions the latest run saw write outside themselves (the coverage event's `impure`), by path. */
const impureOf = new Map<string, ImpureWrite[]>();
/** Each session's tests, when it ran a test file (the run contract's `tests`): kept with its run. */
const testsOf = new Map<string, TestsEvent>();
/** How many of a run's steps its ball rolls through, at most. */
const MAX_PATH = 400;
/** How long a run goes before its ball follows it as it goes: a shorter one's rolls once it's finished. */
const FOLLOW_AFTER = 1000;
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
/** Where the Margin says what went wrong: its log on the editor's observability plane (extension.ts), when there is one. */
let log: ObservedExtension["log"] | undefined;

/** A capability stop's choice, back to its session — the bridge's, where the decider is (ARCHITECTURE.md, *Extension points* 5). */
const choose = async (session: string, choice: CapabilityChoice, rule?: Rule, give?: unknown): Promise<unknown> => vscode.commands.executeCommand("editor.capability.decide", session, choice, rule, give);
/** What a call returned the last time it ran for real (a preview's fetch, recorded), or null. */
const recordedOf = async (capability: string, resource: string): Promise<{ "value": unknown; "at": string } | null> => await recordedResult(capability, resource) ?? null;
/** A variable set at a session's stop (the bridge's). */
const setValueAt = async (session: string, name: string, value: string): Promise<unknown> => vscode.commands.executeCommand("editor.debug.setValue", session, name, value);
/** What a rule gives a file's process.argv, and my policy changed by a rule made in the Rule view — the capabilities
 *  extension's, where the policy is. */
const rulesGiven = async (path: string): Promise<Given | null> => await vscode.commands.executeCommand<Given | null>("silo.rules.given", path, "process.argv") ?? null;
const rulesSet = async (previous: Rule | undefined, rule: Rule | undefined): Promise<unknown> => vscode.commands.executeCommand("silo.rules.set", previous, rule);
/** A file run with given arguments, each a run (Run's, the bridge's). */
const runFile = async (path: string, cases: string[][]): Promise<unknown> => vscode.commands.executeCommand("editor.debugFile", vscode.Uri.file(path), { "cases": cases });
/** What a rule gives each file's process.argv, as last read (null: nothing; undefined: not read yet). */
const givenArgv = new Map<string, Given | null>();

/** Arguments as a command line, as the Mock box takes them. */
function commandLine(args: string[]): string {
	return args.map((arg) => (arg === "" || /[\s"'|]/u.test(arg) ? JSON.stringify(arg) : arg)).join(" ");
}

/** A value's look, by what it reads as. */
function kindOf(value: LiveValue): string {
	// (process.argv's look is `argv`: `live-values-input` is the Mock's box.)
	if (value.kind === "input") {
		return "argv";
	}

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
	const binds = !named && (only.kind === "bind" || only.kind === "set" || only.kind === "input");
	const label = labelOf(only, named, binds);
	const group = `${call}/${depth}`;
	// A call the run didn't make there — skipped, given its recording, or halted before: `<capability> <resource>`.
	const unmade = lineValues.findLast((value) => value.kind === "skip" || value.kind === "given" || value.kind === "halt")?.value;
	const notMade = unmade === undefined ? {} : { "unmade": unmade };

	if (depth === 0) {
		return { "line": line, "label": label, ...binds ? { "name": only.name } : {}, "cells": [], "inline": cellOf(inDepth, named), "group": group, "widths": [], ...anchorOf(inDepth), ...only.kind === "input" ? { "input": true } : {}, ...notMade };
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

/** The rules being made in the Rule view (core's, `editor.rules.edit`), by where — a capability
 *  stop's session, `<uri>#process.argv`, `<uri>#<variable>` — each with how to close it: its button here waits while
 *  it's open. */
const making = new Map<string, () => void>();

/** The choice *Just this once* makes of a rule's decision: deny, skip, or else allow (this call). */
function onceChoice(decision: string | undefined): CapabilityChoice {
	if (decision === "deny") {
		return "deny";
	}

	return decision === "skip" ? "skip" : "allow-once";
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

/** `request` edited in the Rule view (`editor.rules.edit`, ARCHITECTURE.md, *Extension points* 5): the button pressed and the rule as it was
 *  then, or null (cancelled, or closed). Kept as being made, by `key`, until it's answered. */
async function edit(key: string, request: Omit<EditRequest, "id">): Promise<EditAnswer> {
	making.set(key, () => {
		void Promise.resolve(vscode.commands.executeCommand("editor.rules.cancelEdit", key)).catch(() => undefined);
	});

	try {
		return await Promise.resolve(vscode.commands.executeCommand<EditAnswer>("editor.rules.edit", { "id": key, ...request })).catch((error: unknown) => {
			log?.warn("a rule couldn't be edited: the Rule view didn't answer", { "key": key, "error": failureText(error) });

			return null;
		}) ?? null;
	} finally {
		making.delete(key);
	}
}

const CANCEL: EditButton = { "id": "cancel", "label": "Cancel", "className": "cancel", "title": "Close it, changing nothing", "always": true };

/** Rule… at a capability stop: a rule about the call — given what it returned last time it ran for real, when it did
 *  (a preview's fetch) — then *Just this once* (decide this call so), *Save as rule* (in my policy, and decide it so),
 *  *Cancel*. */
async function ruleAtStop(session: string, ask: CapabilityAsk): Promise<void> {
	const recorded = ask.resolved ? await recordedOf(ask.capability, ask.resource).catch(() => null) ?? null : null;
	const answer = await edit(session, {
		...recorded === null ? {} : {
			"rule": {
				"when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": ask.capability }, { "target_id": "resource", "operator_id": "is", "argument": ask.resource }] },
				"then": [{ "action_id": "give", "target_id": "result", "argument": recorded.value }]
			}
		},
		"judge": { "kind": "call", "trigger": "you", "capability": ask.capability, "resource": ask.resource, "resolved": ask.resolved, "canGive": true, ...recorded === null ? {} : { "recorded": recorded } },
		"buttons": [
			{ "id": "once", "label": "Just this once", "className": "once", "title": "Decide this call as the rule does, and stop here again next time" },
			{ "id": "save", "label": "Save as rule", "className": "save", "title": "Keep it in your policy (.silo/policy/<you>.json), and decide this call by it" },
			{ ...CANCEL, "title": "Back to the choices" }
		]
	});

	if (answer?.button === "once") {
		const given = resultOf(answer.rule);

		await (given === undefined ? choose(session, onceChoice(decisionOf(answer.rule))) : choose(session, "give-once", undefined, given.value));
	} else if (answer?.button === "save") {
		await choose(session, "rule", answer.rule);
	}
}

/** Rule… on a call a live run skipped or replayed — a run after an edit, which nobody is watching (RUNNING.md,
 *  unattended runs): a rule about such runs' calls like it — *trigger is edit*, its capability and resource, then give
 *  what it returned when it last ran for real (when that's recorded), else skip — then *Save as rule* (in my policy;
 *  the file runs again by it), *Cancel*. */
async function ruleUnattended(uri: string, capability: string, resource: string): Promise<void> {
	const recorded = await recordedOf(capability, resource).catch(() => null) ?? null;
	const answer = await edit(`${uri}#unattended:${capability} ${resource}`, {
		"rule": {
			"when": { "logicalType_id": "all", "predicates": [{ "target_id": "trigger", "operator_id": "is", "argument": "edit" }, { "target_id": "capability", "operator_id": "is", "argument": capability }, { "target_id": "resource", "operator_id": "is", "argument": resource }] },
			"then": recorded === null ? [{ "action_id": "skip" }] : [{ "action_id": "give", "target_id": "result", "argument": recorded.value }]
		},
		"judge": { "kind": "call", "trigger": "edit", "capability": capability, "resource": resource, "resolved": true, "canGive": true, ...recorded === null ? {} : { "recorded": recorded } },
		"buttons": [
			{ "id": "save", "label": "Save as rule", "className": "save", "title": "Keep it in your policy (.silo/policy/<you>.json): runs after an edit decide this call by it" },
			CANCEL
		]
	});

	if (answer?.button === "save") {
		await rulesSet(undefined, answer.rule);
		await Promise.resolve(vscode.commands.executeCommand("run.live.again", uri)).catch(() => undefined);
	}
}

/** Mock… on process.argv's row: the rule giving it now, or one prefilled — *program is <this file>*, *then give
 *  process.argv* the run's own arguments — then *Run* (with them, once), *Save as rule* (in my policy: every run of the
 *  file is given them), *Remove* (the rule giving it now), *Cancel*. */
async function mockArgv(uri: string, text: string): Promise<void> {
	const { path } = vscode.Uri.parse(uri);
	const program = vscode.workspace.asRelativePath(vscode.Uri.parse(uri), false);
	const given = givenArgv.get(uri) ?? undefined;
	const answer = await edit(`${uri}#process.argv`, {
		"rule": given?.rule ?? {
			"when": { "logicalType_id": "all", "predicates": [{ "target_id": "program", "operator_id": "is", "argument": program }] },
			"then": [{ "action_id": "give", "target_id": "process.argv", "argument": [parseInputs(text)[0] ?? []] }]
		},
		"judge": { "kind": "argv", "program": program },
		"buttons": [
			{ "id": "run", "label": "Run", "className": "once", "title": "Run the file with them, once — each a run of its own" },
			{ "id": "save", "label": "Save as rule", "className": "save", "title": "Keep it in your policy (.silo/policy/<you>.json): every run of the file is given them" },
			...given === undefined ? [] : [{ "id": "remove", "label": "Remove", "className": "remove", "title": "Take the rule away: the file's runs get their own arguments again", "always": true }],
			CANCEL
		]
	});

	switch (answer?.button) {
		case "run":
			void runFile(path, argvRunsOf(answer.rule));
			break;
		case "save":
		case "remove":
			await rulesSet(given?.rule, answer.button === "save" ? answer.rule : undefined);
			givenArgv.set(uri, await rulesGiven(path) ?? null);
			break;
		// no default
	}
}

/** The span reference of the statement at `at` in the code a session ran — or why there isn't one. */
async function statementAt(session: Session, program: string, at: Range): Promise<unknown> {
	const referred = await annotations(vscode.commands).refer(session.anchors.text, program, [{ "start": at[0], "end": at[1] }]);

	if ("unparsable" in referred) {
		throw new Error(`This line can't be placed: the code that ran can't be parsed (${referred.unparsable})`);
	}

	if ("unavailable" in referred) {
		throw new Error(`This line can't be placed: the editor's BABLR isn't available (${referred.unavailable})`);
	}

	const [place] = referred.value;

	if (place === undefined || place === null) {
		throw new Error("This line can't be placed: nothing on it a rule can stand at");
	}

	return place;
}

/** Mock… on a variable's row: *program is <this file>*, *at* <this statement> (a span reference, followed through edits), then
 *  _set_ <it> to the value the run had — then *Just this once* (set at this stop: the run goes on with it), *Save as
 *  rule* (in my policy: each run sets it each time it gets here, without stopping), *Cancel*. */
async function mockVariable(uri: string, at: Range, cell: { "text": string; "kind": string }, name: string, session: Session): Promise<void> {
	const program = vscode.workspace.asRelativePath(vscode.Uri.parse(uri), false);
	const place = await statementAt(session, program, at);

	// The variables the run saw, each by its latest value: targets to test, and to set.
	const latest = new Map<string, LiveValue>();

	for (const value of session.values) {
		if (value.kind === "bind" || value.kind === "set") {
			latest.set(value.name, value);
		}
	}

	const answer = await edit(`${uri}#${name}`, {
		"rule": {
			"when": { "logicalType_id": "all", "predicates": [{ "target_id": "program", "operator_id": "is", "argument": program }, { "target_id": "at", "operator_id": "is", "argument": place }] },
			"then": [{ "action_id": "set", "target_id": `variables.${name}`, "argument": valueOf(cell.text, cell.kind) }]
		},
		"judge": { "kind": "place", "program": program, "place": place, "variables": Object.fromEntries([...latest].map(([each, value]) => [each, valueOf(value.value, kindOf(value))])) },
		"variables": [...latest].map(([each, value]) => ({ "name": each, "kind": kindOf(value) })),
		"buttons": [
			{ "id": "once", "label": "Just this once", "className": "once", "title": "Set it at this stop: the run goes on with it" },
			{ "id": "save", "label": "Save as rule", "className": "save", "title": "Keep it in your policy (.silo/policy/<you>.json): each run sets it each time it gets here" },
			CANCEL
		]
	});

	if (answer?.button === "once") {
		for (const action of answer.rule.then) {
			if (action.action_id === "set" && action.target_id?.startsWith("variables.") === true) {
				await setValueAt(session.id, action.target_id.slice("variables.".length), JSON.stringify(action.argument));
			}
		}
	} else if (answer?.button === "save") {
		await rulesSet(undefined, answer.rule);
	}
}

/** A top-level statement, as tsserver says it (the capabilities plugin's `_statements`): its range, the `//` comment
 *  above it, a title and detail (what it declares or calls), and the types of what it declares. */
interface Statement { "start": number; "end": number; "kind": string; "comment"?: string; "title": string; "detail": string; "declares"?: { "name": string; "type": string | null }[]; "purity"?: Purity }

/** A function's purity, as silo judges it statically (the plugin's `_statements`: lib util/silo/purity) — and why not. */
interface Purity { "verdict": string; "reasons": string[] }

/** A step of the program (RUNTIME-EVIDENCE.md, *Projections*): statements written together, a card around them in the margin. */
interface Step { "fromLine": number; "toLine": number; "title": string; "detail": string; "declares": { "name": string; "type": string | null }[]; "body": boolean; "purity"?: Purity }

/** Each file's top-level statements, by the document version they were read at. */
const statementsRead = new Map<string, { "version": number; "statements": Promise<Statement[] | undefined> }>();
/** Each file's tries at its statements while tsserver isn't ready (it isn't, as a file first opens). */
const statementTries = new Map<string, number>();

/** `document`'s top-level statements, from tsserver — undefined when it can't say yet (it's loading the project). */
function statementsOf(document: vscode.TextDocument): Promise<Statement[] | undefined> {
	const uri = document.uri.toString();
	const known = statementsRead.get(uri);

	if (known?.version === document.version) {
		return known.statements;
	}

	// (each top-level function's purity, onto the statement it's in)
	const statements = Promise.resolve(vscode.commands.executeCommand<{ "body"?: { "statements"?: Statement[] | null; "purity"?: (Purity & { "start": number; "end": number })[] | null } } | undefined>("typescript.tsserverRequest", "_statements", { "file": document.uri })).then((response) => response?.body?.statements?.map((statement) => {
		const purity = response.body?.purity?.find((each) => statement.start <= each.start && each.end <= statement.end);

		return purity === undefined ? statement : { ...statement, "purity": { "verdict": purity.verdict, "reasons": purity.reasons } };
	}) ?? undefined, () => undefined);

	statementsRead.set(uri, { "version": document.version, "statements": statements });
	void statements.then((read) => {
		// Not yet: forget it, and try again in a while (a few times).
		if (read === undefined && statementsRead.get(uri)?.statements === statements) {
			statementsRead.delete(uri);

			const tries = statementTries.get(uri) ?? 0;

			if (tries < 5) {
				statementTries.set(uri, tries + 1);
				setTimeout(() => {
					draw(uri);
				}, 2000);
			}
		}
	});

	return statements;
}

/** An untitled step's name, from what it starts and ends with: `country … total`. */
function stepTitle(title: string, names: string[]): string {
	if (title !== "") {
		return title;
	}

	return names.length <= 2 ? names.join(", ") : `${names[0]} … ${names.at(-1)}`;
}

/** A file's steps: its top-level statements in paragraphs, the way code is written — those with no blank line between
 *  them are one step, a `//` comment above a statement starts one (and titles it), and a function or class is a step of
 *  its own. */
function stepsOf(document: vscode.TextDocument, statements: Statement[]): Step[] {
	const text = document.getText();
	const lines = text.split("\n");
	const steps: (Step & { "end": number; "count": number; "names": string[] })[] = [];
	const bodied = (statement: Statement): boolean => statement.kind === "FunctionDeclaration" || statement.kind === "ClassDeclaration";

	for (const statement of statements) {
		let fromLine = document.positionAt(statement.start).line;

		// Its comment's lines are the step's too.
		while (statement.comment !== undefined && fromLine > 0 && lines[fromLine - 1].trim().startsWith("//")) {
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
			// (a step of several statements has no one verdict)
			delete previous.purity;
		} else {
			steps.push({ "fromLine": fromLine, "toLine": toLine, "end": statement.end, "count": 1, "title": statement.comment ?? "", "names": [statement.title], "detail": statement.detail, "declares": [...statement.declares ?? []], "body": bodied(statement), ...statement.purity === undefined ? {} : { "purity": statement.purity } });
		}
	}

	// Untitled, a step is named by what it starts and ends with: `country … total`.
	return steps.map(({ fromLine, toLine, title, names, detail, declares, body, purity }) => ({ "fromLine": fromLine, "toLine": toLine, "title": stepTitle(title, names), "detail": detail, "declares": declares, "body": body, ...purity === undefined ? {} : { "purity": purity } }));
}

/** The latest run's write outside itself by the function a step is, if it made one (on the step's lines as they were
 *  when it ran: a function's own lines). */
function impureIn(uri: string, step: Step): ImpureWrite | undefined {
	return impureOf.get(vscode.Uri.parse(uri).path)?.find((each) => step.fromLine <= each.start[0] && each.start[0] <= step.toLine);
}

/** What a function step's card says of its purity: silo's verdict, and — judged pure, yet the latest run saw it write
 *  outside itself — that the judgment broke there (a finding: silo README, *Purity*). Undefined for a step that isn't
 *  one function. */
function purityText(step: Step, impure: ImpureWrite | undefined): { "text": string; "title": string; "flagged": boolean } | undefined {
	if (step.purity === undefined) {
		return undefined;
	}

	const { verdict, reasons } = step.purity;
	const why = reasons.length === 0 ? "" : ` — ${reasons.slice(0, 3).join("; ")}${reasons.length > 3 ? "; …" : ""}`;

	if (verdict === "pure" && impure !== undefined) {
		return { "text": `judged pure, but wrote ${impure.what} (line ${impure.line + 1})`, "title": `Judged pure statically, but the latest run saw it write outside itself: ${impure.what} on line ${impure.line + 1}${impure.count > 1 ? `, and ${impure.count - 1} more` : ""}. An assumption the check makes broke here.`, "flagged": true };
	}

	return { "text": verdict, "title": `Purity: ${verdict}${why}`, "flagged": false };
}

/** Whether a step ran, from coverage's marks on its lines (as they're drawn: on the lines their code is on now) — a
 *  function by how often it was called (its body's first mark) — or undefined, with nothing to say. */
function ranOf(step: Step, marks: PaneMark[]): { "kind": string; "text": string } | undefined {
	const covered = marks.filter((mark) => mark.kind.startsWith("coverage-") && step.fromLine <= mark.line && mark.line <= step.toLine);

	if (step.body) {
		const [first] = covered.filter((mark) => mark.line > step.fromLine).sort((left, right) => left.line - right.line);

		if (first === undefined) {
			return undefined;
		}

		const times = /(\d+)×/u.exec(first.title ?? "")?.[1];

		return first.kind === "coverage-missed" ? { "kind": "missed", "text": "not called" } : { "kind": "ran", "text": times === undefined ? "called" : `called ${times}×` };
	}

	if (covered.length === 0) {
		return undefined;
	}

	if (covered.every((mark) => mark.kind === "coverage-ran")) {
		return { "kind": "ran", "text": "ran" };
	}

	return covered.every((mark) => mark.kind === "coverage-missed") ? { "kind": "missed", "text": "didn't run" } : { "kind": "partial", "text": "partly ran" };
}

/** The last run, step by step (RUNTIME-EVIDENCE.md, *Projections*: the run log): each step that ran, in the order it first did, with its
 *  share of the run's work (the statements run in its code — the same every run) and any time it waited (a timer, on the
 *  event loop's clock) — or undefined, with no profile for these steps. */
interface RunLog { "rows": { "card": number; "title": string; "statements": number; "waited": number }[]; "statements": number; "waited": number }

function runLogOf(steps: Step[], profiled: ProfiledLine[]): RunLog | undefined {
	const rows = steps.map((step, card) => {
		const inside = profiled.filter(({ line }) => step.fromLine <= line && line <= step.toLine);

		return { "card": card, "title": step.title, "statements": inside.reduce((sum, each) => sum + each.statements, 0), "waited": inside.reduce((sum, each) => sum + each.waited, 0), "first": Math.min(...inside.map(({ first }) => first)) };
	}).filter((row) => row.statements > 0).sort((left, right) => left.first - right.first);

	return rows.length === 0 ? undefined : { "rows": rows.map(({ "first": _first, ...row }) => row), "statements": rows.reduce((sum, row) => sum + row.statements, 0), "waited": rows.reduce((sum, row) => sum + row.waited, 0) };
}

/** A count, short: 840, 1.2k, 3.4M. */
function shortCount(count: number): string {
	if (count < 1000) {
		return String(count);
	}

	return count < 1e6 ? `${(count / 1000).toFixed(count < 1e4 ? 1 : 0)}k` : `${(count / 1e6).toFixed(1)}M`;
}

/** The Margin of `uri` drawn again: pane-views asks for it (`margin.paneView`, marginOf). */
function draw(uri: string): void {
	void refreshPane(vscode.commands, "margin", uri);
}

/** `items` moved to the lines their code is on now (`anchors`, by each one's `at`), those whose code is gone dropped —
 *  as they are when the file is as it ran, or when there's nothing to place them by. (For margin.state, an agent's
 *  lines: what's drawn is placed by pane-views, from each item's range in the text that ran.) */
async function relocate<T extends { "line": number; "at"?: Range }>(anchors: Anchors | undefined, text: string | undefined, items: T[]): Promise<T[]> {
	if (anchors === undefined || text === undefined || text === anchors.text || items.length === 0) {
		return items;
	}

	const lines = await anchors.lines(text, items.map((item) => item.at ?? [0, 0]));

	return items.flatMap((item, index) => (item.at === undefined || lines[index] === undefined ? [] : [{ ...item, "line": lines[index] }]));
}

/** The file's text as it is now, when it's open. */
function documentText(uri: string): string | undefined {
	return vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri)?.getText();
}

/** Where something a run put on its line `line` is: its range `at` in the text that ran (`anchors`), followed from it to
 *  the file as it is by the editor (pane-views) — or, with nothing to follow it from, that line. */
function placeOf(anchors: Anchors | undefined, line: number, at: Range | undefined): PaneAt {
	return anchors !== undefined && at !== undefined ? { "ran": { "source": anchors.text, "start": at[0], "end": at[1] } } : { "lines": [line, line] };
}

/** A cell's look, as the contract names it — the kinds it knows; any other, plain. */
const CELL_KINDS = new Set(["number", "string", "boolean", "object", "error", "undefined", "branch", "set", "skip", "given"]);

function cellKind(kind: string | undefined): PaneCell["kind"] {
	// (a call a run halted before looks as one it skipped: not made)
	if (kind === "halt") {
		return "skip";
	}

	return kind !== undefined && CELL_KINDS.has(kind) ? kind as PaneCell["kind"] : undefined;
}

/** A capability stop's question, as data: the call and what it reaches, then the choices — each for this call, this
 *  run or always — and *Rule…* (made in the Rule view). */
function askItem(uri: string, asking: { "session": string; "ask": CapabilityAsk; "anchors"?: Anchors }): PaneItem {
	const { session, ask } = asking;
	const always = ask.resolved ? `${ask.capability} on ${ask.resource}, in your policy (.silo/policy/<you>.json)` : undefined;
	const choice = (verb: string, label: string, lasting: [CapabilityChoice, CapabilityChoice, CapabilityChoice], does: string): PaneAction => ({
		"title": label,
		"command": "margin.decide",
		"arguments": [session, lasting[0]],
		"tooltip": `${does}: this call — and stop here again next time`,
		"more": [
			{ "title": "this call", "command": "margin.decide", "arguments": [session, lasting[0]], "tooltip": `${does}: this call` },
			{ "title": "this run", "command": "margin.decide", "arguments": [session, lasting[1]], "tooltip": `${does}: every ${ask.capability} call, until this run ends (kept nowhere)` },
			{ "title": "always", "command": "margin.decide", "arguments": [session, lasting[2]], "tooltip": always === undefined ? "Needs the resource the call reaches, which isn't known before the line runs" : `${does}: ${always}`, ...always === undefined ? { "disabled": true } : {} }
		]
	});
	const code = (text: string): string => `\`${text.replaceAll("`", "'")}\``;

	return {
		"id": "ask",
		"at": placeOf(asking.anchors, ask.line, ask.at),
		"content": { "markdown": `${code(ask.callee)} ${ask.resolved ? code(`'${ask.resource}'`) : `_${ask.resource}_`} ${ask.capability}` },
		"tone": ask.dangerous ? "warning" : "question",
		"actions": [
			choice("allow", "Allow", ["allow-once", "allow-run", "allow-always"], "Let it run, for real"),
			choice("skip", "Skip", ["skip", "skip-run", "skip-always"], "Don't make it: the run goes on as if it did nothing (the debugger's stand-in answers), the line saying it was skipped"),
			choice("deny", "Deny", ["deny", "deny-run", "deny-always"], "Fail it, as a denied call does (EACCES)"),
			{ "title": "Rule…", "command": "margin.rule", "arguments": [uri], "tooltip": making.has(session) ? "Its rule is open in the Rule view" : "Make a rule for calls like this one: which ones, and what to do", ...making.has(session) ? { "disabled": true } : {} }
		]
	};
}

/** A row's *Mock…*: process.argv's, or a variable's (made in the Rule view) — none for a row that's neither. */
function mockOf(uri: string, row: Row, session: Session | undefined): PaneAction | undefined {
	if (row.input === true) {
		const key = `${uri}#process.argv`;

		return { "title": "Mock…", "command": "margin.mockArgv", "arguments": [uri, row.inline?.text ?? ""], "tooltip": "Give the program arguments of your own: once, or by a rule, every run", ...making.has(key) ? { "disabled": true } : {} };
	}

	if (row.name === undefined) {
		return undefined;
	}

	const key = `${uri}#${row.name}`;

	return { "title": "Mock…", "command": "margin.mockVariable", "arguments": [uri, row.name, row.at ?? null, (row.inline ?? row.cells.findLast((each) => each !== undefined))?.text ?? "", (row.inline ?? row.cells.findLast((each) => each !== undefined))?.kind ?? ""], "tooltip": "Give it another value: at this stop, or by a rule, each time the program gets here", ...making.has(key) || row.at === undefined || session?.anchors === undefined ? { "disabled": true } : {} };
}

/** A row's *Rule…* and *Pin…* for a call a live run didn't make — skipped, given its recording (`replayed`), or halted
 *  before: what runs after an edit do with it. *Pin…* keeps a value past runs saw there (RUNNING.md, *Unattended runs*:
 *  past runs are the default). None for any other row, or a run someone was watching. */
function unattendedOf(uri: string, row: Row, session: Session | undefined): PaneAction[] {
	// (a run someone was watching skipped a call because they said so, at its stop)
	const text = session?.live === true ? row.unmade : undefined;

	if (text === undefined || text === "") {
		return [];
	}

	const [capability, ...rest] = text.split(" ");
	const resource = rest.join(" ");
	const key = `${uri}#unattended:${capability} ${resource}`;

	return [
		{ "title": "Rule…", "command": "margin.unattended", "arguments": [uri, capability, resource], "tooltip": making.has(key) ? "Its rule is open in the Rule view" : "What runs after an edit, which nobody is watching, do with this call: a rule", ...making.has(key) ? { "disabled": true } : {} },
		{ "title": "Pin…", "command": "margin.pin", "arguments": [uri, capability, resource, row.line], "tooltip": "Keep a value past runs saw here: runs after an edit are given it (a rule)" }
	];
}

/** A value a run kept as a preview (`'hi'`, `12`, `true`, `null`) as the value itself — undefined for one that isn't a
 *  primitive (an object's preview can't be given back as it was). */
function previewed(text: string): { "value": unknown } | undefined {
	if (/^'[\s\S]*'$/u.test(text)) {
		return { "value": text.slice(1, -1).replaceAll("\\'", "'").replaceAll("\\\\", "\\") };
	}

	if (text === "undefined") {
		return { "value": undefined };
	}

	try {
		const value: unknown = JSON.parse(text);

		return value === null || ["number", "boolean", "string"].includes(typeof value) ? { "value": value } : undefined;
	} catch {
		return undefined;
	}
}

/** The values past runs saw at a call on `line` of `uri`: what it returned the last time it ran for real (its recording),
 *  then the values bound or returned on that line in the runs kept of the file — each once, the most seen first. */
async function pastValues(uri: string, capability: string, resource: string, line: number): Promise<{ "value": unknown; "label": string; "detail": string }[]> {
	const found = new Map<string, { "value": unknown; "label": string; "detail": string; "seen": number }>();
	const recorded = await recordedOf(capability, resource).catch(() => null) ?? null;

	if (recorded !== null) {
		found.set(JSON.stringify(recorded.value) ?? "undefined", { "value": recorded.value, "label": typeof recorded.value === "string" ? `'${recorded.value}'` : String(JSON.stringify(recorded.value) ?? "undefined"), "detail": "what it returned the last time it ran for real", "seen": Number.MAX_SAFE_INTEGER });
	}

	for (const trace of await keptRuns(vscode.workspace.asRelativePath(vscode.Uri.parse(uri), false))) {
		for (const value of trace.values) {
			const parsed = value.line === line && (value.kind === "bind" || value.kind === "return") && value.value !== undefined ? previewed(value.value) : undefined;

			if (parsed !== undefined) {
				const key = JSON.stringify(parsed.value) ?? "undefined";
				const seen = found.get(key);

				found.set(key, seen ?? { "value": parsed.value, "label": value.value ?? "", "detail": `${value.name} — seen in a past run`, "seen": 0 });
				found.get(key).seen += trace.count;
			}
		}
	}

	return [...found.values()].toSorted((left, right) => right.seen - left.seen);
}

/** Pin…*: a value past runs saw at the call, kept as a rule — runs after an edit give the call that value. `value`, when
 *  it's given (an agent, a test), is pinned as it is; else the past values are offered. */
async function pin(uri: string, capability: string, resource: string, line: number, given?: { "value": unknown }): Promise<boolean> {
	let chosen = given;

	if (chosen === undefined) {
		const values = await pastValues(uri, capability, resource, line);

		if (values.length === 0) {
			void vscode.window.showInformationMessage(`No past values for ${capability} ${resource}: once it runs for real (Run, or the terminal), what it returned is there to pin — or Rule… gives any value.`);

			return false;
		}

		const picked = await vscode.window.showQuickPick(values.map((each) => ({ "label": each.label, "detail": each.detail, "value": each.value })), { "title": `Pin ${capability} ${resource}`, "placeHolder": "The value runs after an edit are given" });

		if (picked === undefined) {
			return false;
		}

		chosen = { "value": picked.value };
	}

	await rulesSet(undefined, {
		"when": { "logicalType_id": "all", "predicates": [{ "target_id": "trigger", "operator_id": "is", "argument": "edit" }, { "target_id": "capability", "operator_id": "is", "argument": capability }, { "target_id": "resource", "operator_id": "is", "argument": resource }] },
		"then": [{ "action_id": "give", "target_id": "result", "argument": chosen.value }]
	});
	await Promise.resolve(vscode.commands.executeCommand("run.live.again", uri)).catch(() => undefined);

	return true;
}

/** A row a run put on a line, as data: a function's call picker, its label, the line's own value, a column a turn of a
 *  loop (one held lit), and *Mock…* — process.argv's, or a variable's (made in the Rule view). */
function rowItem(uri: string, row: Row, index: number, session: Session | undefined): PaneItem {
	const { picker } = row;
	const step = (by: number, text: string, title: string): PaneCell => {
		const to = picker === undefined ? -1 : picker.index + by;

		return { "text": text, "title": title, ...picker !== undefined && to >= 0 && to < picker.count ? { "command": { "title": title, "command": "margin.pick", "arguments": [uri, picker.function, to, picker.count] } } : {} };
	};

	const given = row.input === true ? givenArgv.get(uri) : undefined;
	const actions = [mockOf(uri, row, session), ...unattendedOf(uri, row, session)].filter((action) => action !== undefined);

	return {
		"id": `values:${index}`,
		"at": row.input === true && row.at === undefined ? { "lines": [row.line, row.line] } : placeOf(session?.anchors, row.line, row.at),
		"content": {
			...row.label === "" ? {} : { "label": row.label },
			...picker === undefined ? {} : { "lead": [step(-1, "‹", "The call before"), { "text": `${picker.index + 1}/${picker.count}`, "title": `Call ${picker.index + 1} of ${picker.count}` }, step(1, "›", "The call after")] },
			...row.inline === undefined ? {} : { "value": { "text": row.inline.text, "kind": cellKind(row.inline.kind) } },
			"cells": given === null || given === undefined
				? row.cells.map((cell, column) => (cell === undefined ? { "text": "" } : { "text": cell.text, "kind": cellKind(cell.kind), "picked": session?.held === `${row.group}#${column}`, "command": { "title": "Hold", "command": "margin.hold", "arguments": [uri, `${row.group}#${column}`] } }))
				: [{ "text": given.values.map(commandLine).join("  ·  "), "kind": "given", "title": `Given by a rule in your policy${given.values.length > 1 ? `: ${given.values.length} runs, one after another` : ""}` }]
		},
		...actions.length === 0 ? {} : { "actions": actions }
	};
}

/** A session's rows — those with nothing to follow them by gone, once the file's changed from what ran (`text`). */
function rowsShown(session: Session | undefined, text: string | undefined): Row[] {
	// (a run's rows with nothing to follow them by, once the file's changed from what ran, are gone)
	const moved = session?.anchors !== undefined && text !== undefined && text !== session.anchors.text;

	return session === undefined ? [] : rowsOf(session.values, session.calls, session.picked).filter((row) => !moved || row.at !== undefined);
}

/** process.argv's row, before any run (or a run that didn't read it yet), added to `rows`: on the first line reading it,
 *  with the file's stub if it has one — so the inputs can be written first. */
function addArgvRow(uri: string, text: string | undefined, rows: Row[]): void {
	const readsArgv = text !== undefined && /\bprocess\.argv\b/u.test(text);
	const argvAt = !readsArgv || rows.some((row) => row.input === true) ? -1 : text.split("\n").findIndex((each) => /\bprocess\.argv\b/u.test(each));

	// What a rule gives the file's process.argv, read once (then again as it's changed here), for its row.
	if (readsArgv && !givenArgv.has(uri)) {
		givenArgv.set(uri, null);
		void rulesGiven(vscode.Uri.parse(uri).path).then((given) => {
			givenArgv.set(uri, given);
			draw(uri);
		}, () => undefined);
	}

	// (No value of its own: nothing ran. What a rule gives it is beside it.)
	if (argvAt !== -1) {
		rows.push({ "line": argvAt, "label": "process.argv =", "name": "process.argv", "cells": [], "inline": { "text": "", "kind": "argv" }, "group": "0/0", "widths": [], "input": true });
	}
}

/** What the bounds left out, under the last line (`last`'s). */
function droppedItems(uri: string, last: Row | undefined, session: Session | undefined): PaneItem[] {
	return last === undefined || session === undefined || session.dropped === 0 ? [] : [{ "id": "values:dropped", "at": rowItem(uri, last, -1, session).at, "content": { "markdown": `… ${session.dropped} more values not kept` }, "tone": "info" } satisfies PaneItem];
}

/** How the last run ended, for the run log. */
function endedText(ending: (RunEnd & { "anchors"?: Anchors }) | undefined): string {
	if (ending?.kind === "crashed") {
		return `crashed at line ${ending.line + 1}`;
	}

	return ending?.kind === "stopped" ? `stopped at line ${ending.line + 1}` : "completed";
}

/** The run log: how the run ended, and a line per step that ran — its card's number and title, its share of the work
 *  (statements run, the same every run), what it waited. At the file's end (`logLine`, after the last card). */
function runLogItems(runLog: RunLog | undefined, logLine: number, ending: (RunEnd & { "anchors"?: Anchors }) | undefined): PaneItem[] {
	const ended = endedText(ending);

	return runLog === undefined ? [] : [
		{ "id": "runlog", "at": { "lines": [logLine, logLine] }, "content": { "markdown": `**Last run** · ${shortCount(runLog.statements)} statements${runLog.waited > 0 ? ` · waited ${runLog.waited}ms` : ""} · ${ended}` }, ...ending === undefined ? {} : { "tone": "error" } } satisfies PaneItem,
		...runLog.rows.map((row, index): PaneItem => {
			const share = Math.round((row.statements / runLog.statements) * 100);

			return { "id": `runlog:${index}`, "at": { "lines": [logLine, logLine] }, "content": { "lead": [{ "text": String(row.card + 1) }], "label": row.title, "cells": [{ "text": share === 0 ? "<1%" : `${share}%`, "title": `${row.statements} statements` }, ...row.waited > 0 ? [{ "text": `waited ${row.waited}ms` }] : []] } };
		})
	];
}

/** What a mark on the line the last run ended on says. */
function endTitle(ending: RunEnd & { "anchors"?: Anchors }): string {
	if (ending.kind === "crashed") {
		return `The last run crashed here: ${ending.message ?? "an uncaught error"}`;
	}

	return ending.message === undefined ? "The last run was stopped here" : `The last run stopped here: ${ending.message}`;
}

/** margin.state's plain account of a Margin, an agent's: on the lines each thing is on now (1-based). */
function marginState(uri: string, session: Session | undefined, stated: Row[], askedAt: CapabilityAsk | undefined, end: (RunEnd & { "anchors"?: Anchors }) | undefined, lineMarks: PaneMark[], steps: Step[], runLog: RunLog | undefined): MarginState {
	return {
		"file": vscode.Uri.parse(uri).path,
		"values": stated.map((row) => ({ "line": row.line + 1, "label": row.label, "cells": row.inline === undefined ? row.cells.map((cell) => cell?.text ?? "") : [row.inline.text] })),
		"dropped": session?.dropped ?? 0,
		...askedAt === undefined ? {} : { "ask": { "line": askedAt.line + 1, "call": askedAt.callee, "capability": askedAt.capability, "resource": askedAt.resource, "resolved": askedAt.resolved } },
		...end === undefined ? {} : { "end": { "line": end.line + 1, "kind": end.kind, ...end.message === undefined ? {} : { "message": end.message } } },
		"marks": [...lineMarks, ...end === undefined ? [] : [{ "line": end.line, "kind": `run-${end.kind}`, ...end.message === undefined ? {} : { "title": end.message } }]].map((mark) => ({ "line": mark.line + 1, "kind": mark.kind, ...mark.title === undefined ? {} : { "title": mark.title } })),
		"cards": steps.map((step) => {
			const purity = purityText(step, impureIn(uri, step));

			return { "fromLine": step.fromLine + 1, "toLine": step.toLine + 1, "title": step.title, ...purity === undefined ? {} : { "purity": step.purity.verdict, ...purity.flagged ? { "flagged": purity.text } : {} } };
		}),
		...runLog === undefined ? {} : { "runLog": runLog },
		"runs": (kept.get(uri) ?? []).map((run) => ({ "id": run.id, "picked": run === session, ...stateOf(run) === undefined ? {} : { "state": stateOf(run) } }))
	};
}

/** What `uri`'s Margin shows, as data (the contract's PaneContent: pane-views draws it) — or nothing, for a file that
 *  isn't code with nothing on it. And margin.state's plain account of it, an agent's. */
async function marginOf(uri: string): Promise<PaneContent | undefined> {
	const session = sessions.get(uri);
	const text = documentText(uri);
	const rows = rowsShown(session, text);
	const asking = asks.get(uri);
	const ending = ends.get(uri);
	// The program's steps, a card around each (RUNTIME-EVIDENCE.md, *Projections*).
	const shown = vscode.workspace.textDocuments.find((each) => each.uri.toString() === uri);
	const read = shown === undefined || !CODE.has(shown.languageId) ? undefined : await statementsOf(shown);
	const steps = read === undefined || shown?.getText() !== text ? [] : stepsOf(shown, read);

	addArgvRow(uri, text, rows);

	const last = rows.reduce<Row | undefined>((latest, row) => (latest === undefined || row.line > latest.line ? row : latest), undefined);
	// A run picked from those kept shows its own coverage and run log (kept with it as it was the latest); the latest, the
	// marks as they are now.
	const older = session !== undefined && session !== kept.get(uri)?.at(-1);
	// The last run, step by step, at the file's end (after the last card).
	const profiled = older && session.profile !== undefined ? session.profile : profiles.get(uri);
	const runLog = profiled === undefined || steps.length === 0 ? undefined : runLogOf(steps, profiled);
	const logLine = shown === undefined ? 0 : Math.max(shown.lineCount - 1, ...steps.map((step) => step.toLine));
	// Coverage's marks (coverage.ts draws them, into the Margin): each card says from them how its code ran.
	const lineMarks: PaneMark[] = (older ? session.marks : undefined) ?? marked.get(uri) ?? [];
	const items: PaneItem[] = [
		// A capability stop's question first on its line: it's what the run waits on.
		...asking === undefined ? [] : [askItem(uri, asking)],
		...rows.map((row, index) => rowItem(uri, row, index, session)),
		...droppedItems(uri, last, session),
		...runLogItems(runLog, logLine, ending)
	];
	const marks: ContentMark[] = [
		...ending === undefined ? [] : [{ "at": placeOf(ending.anchors, ending.line, ending.at), "kind": ending.kind, "title": endTitle(ending) } satisfies ContentMark]
	];
	const groups = steps.map((step, index): PaneGroup => {
		const ran = ranOf(step, lineMarks);
		const purity = purityText(step, impureIn(uri, step));

		return {
			"id": `step:${index}`,
			"at": { "lines": [step.fromLine, step.toLine] },
			"label": step.title,
			...step.detail === "" && purity === undefined ? {} : { "detail": [step.detail, purity?.text].filter((each) => each !== undefined && each !== "").join(" · ") },
			...step.declares.length === 0 && purity === undefined ? {} : { "title": [...step.declares.map(({ name, type }) => (type === null ? name : `${name}: ${type}`)), ...purity === undefined ? [] : [purity.title]].join("\n") },
			...ran === undefined ? {} : { "state": ran.kind as PaneGroup["state"], "stateText": ran.text }
		};
	});

	// What an agent reads of it (margin.state): on the lines each is on now.
	const stated = await relocate(session?.anchors, text, rows);
	const [askedAt] = asking === undefined ? [] : await relocate(asking.anchors, text, [asking.ask]);
	const [end] = ending === undefined ? [] : await relocate(ending.anchors, text, [ending]);

	margins.set(uri, marginState(uri, session, stated, askedAt, end, lineMarks, steps, runLog));

	// Only a file that isn't code, with nothing in it, goes without.
	if (items.length === 0 && !open.has(uri) && marks.length === 0 && steps.length === 0) {
		return undefined;
	}

	return { "items": items, "groups": groups, "marks": marks, ...runsShown(uri, session) };
}

/** The file's runs kept, and where the one shown went once it's finished (its ball rolls along it) — or, going for a
 *  while, where it is now (its ball follows it). */
function runsShown(uri: string, session: Session | undefined): Pick<PaneContent, "runs" | "path"> {
	const runs = runsOf(uri, session);
	let path: PanePath | undefined;

	if (session?.done === true) {
		path = pathOf(session);
	} else if (session?.now !== undefined && Date.now() - (session.at ?? Date.now()) >= FOLLOW_AFTER) {
		path = { "id": session.id, "at": [placeOf(session.anchors, session.now.line, session.now.at)], "live": true };
	}

	return { ...runs.length === 0 ? {} : { "runs": runs }, ...path === undefined ? {} : { "path": path } };
}

/** How a kept run ended, as its ball's colour: ran to its end, crashed, stopped short — none while it's running. */
function stateOf(run: Session): PaneRun["state"] {
	if (run.done !== true) {
		return undefined;
	}

	if (run.end === undefined) {
		return "ran";
	}

	return run.end.kind === "crashed" ? "crashed" : "stopped";
}

/** How a kept run went, in words: as its state says, or still running. */
const HOW: Record<string, string> = { "ran": "ran to its end", "crashed": "crashed", "stopped": "stopped short" };

/** A file's kept runs, a ball each: when it ran and how it went on hover, the one shown held, a click picking it. */
function runsOf(uri: string, shown: Session | undefined): PaneRun[] {
	return (kept.get(uri) ?? []).map((run) => {
		const state = stateOf(run);
		const how = state === undefined ? "running" : HOW[state];
		const when = run.at === undefined ? "" : `${new Date(run.at).toLocaleTimeString()} — `;

		const times = (run.count ?? 1) > 1 ? ` (${run.count} runs alike)` : "";

		return { "id": run.id, "title": `${when}${run.live === true ? "after an edit, " : ""}${how}, ${run.values.length} value${run.values.length === 1 ? "" : "s"}${times}`, ...state === undefined ? {} : { "state": state }, "picked": run === shown, "command": { "title": "Show this run", "command": "margin.pickRun", "arguments": [uri, run.id] } };
	});
}

/** Where `source` (the text a run of `uri` ran) puts values, and which are built from its literals alone (the
 *  capabilities plugin's `_determined`: lib util/silo/purity) — none unless the file's open with that very text, the
 *  offsets tsserver's answer is in. */
async function determinedIn(uri: string, source: string): Promise<Determined[] | undefined> {
	const document = vscode.workspace.textDocuments.find((each) => each.uri.toString() === uri);

	if (document?.getText() !== source) {
		return undefined;
	}

	const response = await Promise.resolve(vscode.commands.executeCommand<{ "body"?: { "places"?: Determined[] | null } } | undefined>("typescript.tsserverRequest", "_determined", { "file": document.uri })).catch(() => undefined);

	return document.getText() === source ? (response?.body?.places ?? undefined) : undefined;
}

/** A finished run, kept (runs.ts): the same run as one kept already is that one, counted again (its ball, not a new
 *  one); else a trace of it, on this machine — a commit shares those of the text it commits (git-engine.ts). */
async function keepSession(id: string, live = false): Promise<void> {
	const inputs = inputsOf.get(id) ?? [];
	const executed = executedOf.get(id);
	const tests = testsOf.get(id);

	inputsOf.delete(id);
	executedOf.delete(id);
	testsOf.delete(id);

	if (tests !== undefined) {
		await keepTests(tests, inputs, live ? "edit" : "you");
	}

	for (const [uri, runs] of kept) {
		const run = runs.find((each) => each.id === id);

		if (run?.done !== true || run.anchors === undefined) {
			continue;
		}

		const source = run.anchors.text;
		const { path } = vscode.Uri.parse(uri);
		// Its code, by BABLR's spans of the text it ran: the top-level declarations it executed (its coverage, else where its
		// values and calls were) and the span around each value. None when the text can't be parsed: then its text is it.
		const answer = await annotations(vscode.commands).spans(source).catch(() => undefined);
		const spans = answer !== undefined && "value" in answer ? answer.value : undefined;
		const offsetOf = offsetsIn(source);
		const ran: [number, number][] = [
			...(executed?.get(path) ?? []).map(([start, end]): [number, number] => [offsetOf(start), offsetOf(end)]),
			...run.values.flatMap((value) => (value.at === undefined ? [] : [value.at])),
			...[...run.calls.values()].flatMap((call) => (call.at === undefined ? [] : [call.at]))
		];
		const declarations = spans === undefined ? undefined : declarationsHolding(spans, ran);
		// A run that may have read: which of its values were built from the file's literals alone, shared as they were.
		const places = inputs.length > 0 || run.values.some((value) => value.kind === "input") || mayRead(source) ? await determinedIn(uri, source) : undefined;
		const trace: RunTrace = {
			"id": run.id,
			"file": vscode.workspace.asRelativePath(vscode.Uri.parse(uri), false),
			"oid": await blobOid(source),
			...declarations === undefined || declarations.length === 0 ? {} : { "declarations": declarations },
			"trigger": run.live === true ? "edit" : "you",
			"at": new Date(run.at ?? Date.now()).toISOString(),
			"count": 1,
			...run.end === undefined ? {} : { "end": { "kind": run.end.kind, "line": run.end.line, ...run.end.at === undefined ? {} : { "at": run.end.at }, ...run.end.message === undefined ? {} : { "message": run.end.message } } },
			"inputs": [...new Set(inputs)].toSorted(),
			"values": run.values.map((value) => {
				const span = spans === undefined || value.at === undefined ? undefined : spanAround(spans, value.at[0], value.at[1]);

				const determined = places !== undefined && value.at !== undefined && (value.kind === "bind" || value.kind === "return") && determinedAt(places, value.at);

				return { "line": value.line, "name": value.name, "kind": value.kind, "call": value.call, "turns": value.turns, "value": value.value, ...value.at === undefined ? {} : { "at": value.at }, ...span === undefined ? {} : { "span": span.id }, ...determined ? { "determined": true as const } : {} };
			}),
			"calls": [...run.calls.values()],
			"source": source
		};
		const key = traceKey(trace);
		const same = runs.find((each) => each !== run && each.key === key);

		if (same === undefined) {
			run.key = key;
			run.count = 1;
		} else {
			// The same run again: one ball, counted — shown, as the latest.
			same.count = (same.count ?? 1) + 1;
			same.at = run.at;
			kept.set(uri, [...runs.filter((each) => each !== run && each !== same), same]);

			if (sessions.get(uri) === run) {
				sessions.set(uri, same);
			}
		}

		draw(uri);
		await keepRun(trace, KEPT);
	}
}

/** A test file's tests, each kept as a trace on every file it ran (lib traces' `test`): the top-level declarations of
 *  that file its statements are in, by BABLR's spans of the file as it is now — so a file's traces say which tests
 *  reach it, by the same declarations its runs are identified by. A file that changed since it ran is placed as it is
 *  (a test file's run is short). */
async function keepTests({ file, tests }: TestsEvent, inputs: string[], trigger: RunTrace["trigger"]): Promise<void> {
	const testFile = vscode.workspace.asRelativePath(vscode.Uri.file(file), false);
	const at = new Date().toISOString();
	const texts = new Map<string, Promise<{ "source": string; "spans"?: Span[] } | undefined>>();
	const placed = (path: string) => {
		if (!texts.has(path)) {
			texts.set(path, (async () => {
				const source = await vscode.workspace.fs.readFile(vscode.Uri.file(path)).then((bytes) => new TextDecoder().decode(bytes), () => undefined);

				if (source === undefined) {
					return undefined;
				}

				const answer = await annotations(vscode.commands).spans(source).catch(() => undefined);

				return { "source": source, ...answer !== undefined && "value" in answer ? { "spans": answer.value } : {} };
			})());
		}

		return texts.get(path);
	};

	for (const test of tests) {
		for (const ran of test.files) {
			const text = await placed(ran.file);

			if (text?.spans === undefined) {
				continue;
			}

			const offsetOf = offsetsIn(text.source);
			const declarations = declarationsHolding(text.spans, ran.statements.map(([start, end]): [number, number] => [offsetOf(start), offsetOf(end)]));

			if (declarations.length === 0) {
				continue;
			}

			await keepRun({
				"id": crypto.randomUUID(),
				"file": vscode.workspace.asRelativePath(vscode.Uri.file(ran.file), false),
				"oid": await blobOid(text.source),
				"declarations": declarations,
				"trigger": trigger,
				"test": { "id": [testFile, ...test.titles].join(" › "), "outcome": test.outcome },
				"at": at,
				"count": 1,
				"inputs": [...new Set(inputs)].toSorted(),
				"values": [],
				"calls": [],
				"source": text.source
			}, KEPT);
		}
	}
}

/** The offset of a [line, character] position in `text`. */
function offsetsIn(text: string): (position: [number, number]) => number {
	const starts = [0];

	for (let index = text.indexOf("\n"); index !== -1; index = text.indexOf("\n", index + 1)) {
		starts.push(index + 1);
	}

	return ([line, character]) => (starts[line] ?? text.length) + character;
}

/** A file's runs kept on this machine (runs.ts), its balls again — as a file is first shown, before any run of it here. */
async function restoreRuns(uri: string): Promise<void> {
	if ((kept.get(uri) ?? []).length > 0) {
		return;
	}

	const { path } = vscode.Uri.parse(uri);
	const traces = await keptRuns(vscode.workspace.asRelativePath(vscode.Uri.parse(uri), false));
	const runs = traces.filter((trace) => trace.source !== undefined).map((trace): Session => {
		const anchors = new Anchors(vscode, path, trace.source ?? "");

		return {
			"id": trace.id,
			"values": trace.values.map((value) => ({ "line": value.line, "name": value.name, "value": value.value ?? `‹${value.type ?? "value"}›`, "kind": value.kind as LiveValue["kind"], "call": value.call, "turns": value.turns, ...value.at === undefined ? {} : { "at": value.at } })),
			"calls": new Map(trace.calls.map((call) => [call.id, call])),
			"dropped": 0,
			"picked": new Map(),
			"anchors": anchors,
			"at": Date.parse(trace.at),
			"done": true,
			...trace.end === undefined ? {} : { "end": { ...trace.end, "anchors": anchors } },
			...trace.trigger === "edit" ? { "live": true } : {},
			"count": trace.count,
			"key": traceKey(trace)
		};
	});

	// (a run that came meanwhile is newer: it stays shown)
	if (runs.length === 0 || (kept.get(uri) ?? []).length > 0) {
		return;
	}

	kept.set(uri, runs);

	const last = runs.at(-1);

	sessions.set(uri, last);

	if (last.end === undefined) {
		ends.delete(uri);
	} else {
		ends.set(uri, last.end);
	}
}

/** Where a run went, a step a value (in the order they came: the order it ran), each where it was in the text that ran
 *  — the same line twice running counted once. */
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

/** Where `uri`'s last run's work went (coverage.ts: tsval's profile, on the lines its statements are on now), for the
 *  run log — or none. */
export function showProfile(uri: string, lines: ProfiledLine[] | undefined): void {
	if (lines === undefined || lines.length === 0) {
		profiles.delete(uri);
	} else {
		profiles.set(uri, lines);
	}

	// (kept with the latest run, for when it's picked later)
	const latest = kept.get(uri)?.at(-1);

	if (latest !== undefined && lines !== undefined) {
		latest.profile = lines;
	}

	draw(uri);
}

/** The marks beside `uri`'s lines in the margin's gutter column (coverage's), replacing its last. */
export function showMarks(uri: string, marks: PaneMark[]): void {
	marked.set(uri, marks);

	// (kept with the latest run, for when it's picked later)
	const latest = kept.get(uri)?.at(-1);

	if (latest !== undefined) {
		latest.marks = marks;
	}

	draw(uri);
}

/** Keep a margin beside every code file shown, and follow debug sessions' values and capability stops — saying what goes
 *  wrong to `logger`. */
export function registerMargin(logger?: ObservedExtension["log"]): void {
	log = logger;
	// The Margin, a pane view (ARCHITECTURE.md, *Extension points* 4): its content, asked for by pane-views — and what its buttons and
	// cells run. Each rule it makes opens in the Rule view (rule-view.ts); its button waits while it's open.
	const uriArg = (value: unknown): string => {
		if (typeof value !== "string") {
			throw new TypeError("a file's URI");
		}

		return value;
	};

	/** `edited` (an edit in the Rule view), the Margin drawn as it opens (its button waiting) and again as it closes. */
	const editing = (uri: string, edited: Promise<void>): Promise<void> => {
		draw(uri);

		return edited.finally(() => {
			draw(uri);
		});
	};

	vscode.commands.registerCommand("margin.paneView", async (uri: unknown) => (typeof uri === "string" ? marginOf(uri) : undefined));
	vscode.commands.registerCommand("margin.decide", async (session: unknown, choice: unknown) => {
		if (typeof session !== "string" || typeof choice !== "string") {
			throw new TypeError("margin.decide: a session and a choice");
		}

		return choose(session, choice as CapabilityChoice);
	});
	vscode.commands.registerCommand("margin.rule", async (value: unknown) => {
		const uri = uriArg(value);
		const asking = asks.get(uri);

		if (asking === undefined) {
			throw new Error("not stopped at a capability call");
		}

		await editing(uri, ruleAtStop(asking.session, asking.ask));
	});
	// A run kept, picked (its ball at the Margin's top): its values shown, how it ended, and its ball rolled again.
	vscode.commands.registerCommand("margin.pickRun", (value: unknown, id: unknown) => {
		const uri = uriArg(value);
		const run = kept.get(uri)?.find((each) => each.id === id);

		if (run === undefined) {
			throw new Error("that run isn't kept any more");
		}

		sessions.set(uri, run);

		if (run.end === undefined) {
			ends.delete(uri);
		} else {
			ends.set(uri, run.end);
		}

		draw(uri);
	});
	vscode.commands.registerCommand("margin.unattended", async (value: unknown, capability: unknown, resource: unknown) => {
		const uri = uriArg(value);

		if (typeof capability !== "string" || typeof resource !== "string") {
			throw new TypeError("margin.unattended: a call's capability and resource");
		}

		await editing(uri, ruleUnattended(uri, capability, resource));
	});
	vscode.commands.registerCommand("margin.pin", async (value: unknown, capability: unknown, resource: unknown, line: unknown, given?: unknown) => {
		if (typeof capability !== "string" || typeof resource !== "string" || typeof line !== "number") {
			throw new TypeError("margin.pin: a call's capability, resource and line");
		}

		return pin(uriArg(value), capability, resource, line, given === undefined ? undefined : { "value": given });
	});
	vscode.commands.registerCommand("margin.mockArgv", async (value: unknown, text: unknown) => {
		const uri = uriArg(value);

		await editing(uri, mockArgv(uri, typeof text === "string" ? text : ""));
	});
	vscode.commands.registerCommand("margin.mockVariable", async (value: unknown, name: unknown, at: unknown, text: unknown, kind: unknown) => {
		const uri = uriArg(value);
		const session = sessions.get(uri);

		if (typeof name !== "string" || !Array.isArray(at) || session === undefined) {
			throw new Error("nothing to mock here: the run's values are gone");
		}

		await editing(uri, mockVariable(uri, at as Range, { "text": typeof text === "string" ? text : "", "kind": typeof kind === "string" ? kind : "" }, name, session));
	});
	// A function's call picked on its first line (the latest is no pick: it follows the calls still coming).
	vscode.commands.registerCommand("margin.pick", (value: unknown, key: unknown, index: unknown, count: unknown) => {
		const uri = uriArg(value);
		const session = sessions.get(uri);

		if (session !== undefined && typeof key === "string" && typeof index === "number" && typeof count === "number") {
			if (index === count - 1) {
				session.picked.delete(key);
			} else {
				session.picked.set(key, index);
			}

			draw(uri);
		}
	});
	// A click holds a column lit; another lets it go.
	vscode.commands.registerCommand("margin.hold", (value: unknown, key: unknown) => {
		const uri = uriArg(value);
		const session = sessions.get(uri);

		if (session !== undefined && typeof key === "string") {
			session.held = session.held === key ? undefined : key;
			draw(uri);
		}
	});

	// At a stop, the values as VS Code's own inline values too (its InlineValuesProvider: the debugger's documented contract
	// for values beside the code) — each row's latest at the end of its line, on the line its code is on now, as the margin
	// places it. For the session VS Code stopped in, its frame in focus — whichever debugger's. (A desktop build would show values this way,
	// with no pane beside the editor.) VS Code asks as it stops, while the stop's last values may still be on their way (by
	// the hub, not with the stop): so it's answered once they're in — that session's values here, and a moment's quiet.
	vscode.languages.registerInlineValuesProvider({ "scheme": "file" }, {
		"provideInlineValues": async (document, viewport) => {
			const uri = document.uri.toString();
			// (the session VS Code asks for: its focused frame's — a live run, or another session, may be the active one)
			const stopped = vscode.debug.activeStackItem?.session.id ?? vscode.debug.activeDebugSession?.id;

			for (let waited = 0; waited < 2000 && (sessions.get(uri)?.id !== stopped || Date.now() - (batchedAt.get(uri) ?? 0) < 200); waited += 50) {
				await new Promise((resolve) => {
					setTimeout(resolve, 50);
				});
			}

			const session = sessions.get(uri);

			// (none asked for: no session is the one)
			if (stopped === undefined || session?.id !== stopped) {
				return [];
			}

			const rows = await relocate(session.anchors, document.getText(), rowsOf(session.values, session.calls, session.picked));

			return rows.flatMap((row) => {
				const latest = row.inline?.text ?? row.cells.findLast((cell) => cell !== undefined && cell.text !== "")?.text;

				return latest === undefined || row.line < viewport.start.line || row.line > viewport.end.line || row.line >= document.lineCount ? [] : [new vscode.InlineValueText(document.lineAt(row.line).range, row.label === "" ? latest : `${row.label} ${latest}`)];
			});
		}
	});

	const uriOf = (path: string): string => vscode.Uri.file(path).toString();
	/** The text a session ran, as anchors (the same for its values, its question and its end). */
	const anchorsFor = (file: string, source: unknown, session?: Session): Anchors | undefined => session?.anchors ?? (typeof source === "string" ? new Anchors(vscode, file, source) : undefined);
	const follow = (editors: readonly vscode.TextEditor[]): void => {
		for (const editor of editors) {
			const uri = editor.document.uri.toString();

			if (CODE.has(editor.document.languageId) && !open.has(uri)) {
				open.add(uri);
				draw(uri);
				void restoreRuns(uri).then(() => {
					draw(uri);
				}, () => undefined);
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
			typing.set(uri, setTimeout(() => {
				draw(uri);
			}, 300));
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

	/** A session's values, as they come (the `values` event). */
	const valuesCame = (id: string, { file, source, replace, ...batch }: ValuesEvent): void => {
		if (typeof file !== "string" || !Array.isArray(batch.values)) {
			return;
		}

		const uri = uriOf(file);
		let session = sessions.get(uri);

		// A new session over the file replaces the last one's values, and how the last run ended — as a report of every
		// value so far (`replace`: a preview's recorded stops) replaces its own last.
		if (session?.id !== id || replace === true) {
			const runs = (kept.get(uri) ?? []).filter((each) => each.id !== id);

			session = { "id": id, "values": [], "calls": new Map(), "dropped": 0, "picked": new Map(), "at": Date.now(), ...liveSessions.has(id) ? { "live": true } : {} };
			sessions.set(uri, session);
			kept.set(uri, [...runs, session].slice(-KEPT));
			ends.delete(uri);
		}

		// Running again past a capability stop: its question's answered (by the toolbar, say — whoever answered it).
		if (asks.get(uri)?.session === id && replace !== true) {
			making.get(id)?.();
			making.delete(id);
			asks.delete(uri);
		}

		session.anchors ??= anchorsFor(file, source);
		session.values.push(...batch.values);
		session.now = batch.now ?? batch.values.at(-1) ?? session.now;

		for (const call of batch.calls ?? []) {
			session.calls.set(call.id, call);
		}

		session.dropped = batch.dropped ?? session.dropped;
		batchedAt.set(uri, Date.now());
		redraw(uri);
	};

	// The run's end: how it ended goes on its line. Its values stay — the margin shows the file's last run until the next
	// run of it tells its own (a live run on a save or its interval, RUNTIME-EVIDENCE.md, *Live runs*), following its code through edits.
	const endedCame = (session: string, { file, source, end }: Partial<EndedEvent>): void => {
		// How it ended — crashed, or stopped on a line — replacing the last run's; a run that finished clears it.
		if (typeof file === "string") {
			const ran = sessions.get(uriOf(file));
			const run = kept.get(uriOf(file))?.find((each) => each.id === session);
			const ending = end === undefined ? undefined : { ...end, "anchors": anchorsFor(file, source, ran?.id === session ? ran : run) };

			if (ending === undefined) {
				ends.delete(uriOf(file));
			} else {
				ends.set(uriOf(file), ending);
			}

			// (kept with the run: picked again, it says how it ended — and its ball rolls, now that its path is whole)
			if (run !== undefined) {
				run.done = true;
				run.end = ending;
			}

			redraw(uriOf(file));
		}

		if (typeof file === "string" && asks.get(uriOf(file))?.session === session) {
			making.get(session)?.();
			making.delete(session);
			asks.delete(uriOf(file));
			redraw(uriOf(file));
		}
	};

	// What a file's Margin shows (the `margin_state` tool, which the bridge answers by this): the file open in the
	// editor, or `file`, once it's been drawn.
	vscode.commands.registerCommand("margin.state", (file: unknown) => {
		let path: string | undefined;

		if (typeof file === "string" && file !== "") {
			path = file.startsWith("/") ? file : `/workspace/${file}`;
		} else {
			path = vscode.window.activeTextEditor?.document.uri.path;
		}

		const state = path === undefined ? undefined : [...margins.values()].find((each) => each.file === path);

		if (state === undefined) {
			throw new Error(path === undefined ? "no file open in the editor — pass one" : `${path} has no Margin drawn — open it in the editor`);
		}

		return state;
	});

	// The policy files changed: what a rule gives each file's process.argv is read anew (once the pod has), and whoever
	// lists them is told.
	const watcher = vscode.workspace.createFileSystemWatcher(POLICY_GLOB);
	let changed: ReturnType<typeof setTimeout> | undefined;
	const reread = (): void => {
		clearTimeout(changed);
		changed = setTimeout(() => {
			givenArgv.clear();

			for (const uri of open) {
				draw(uri);
			}
		}, 300);
	};

	watcher.onDidChange(reread);
	watcher.onDidCreate(reread);
	watcher.onDidDelete(reread);
	/** A capability stop's question, on its line (the `ask` event) — or none (`ask` undefined): it was answered. */
	const askCame = (session: string, file: string, source: string | undefined, ask: CapabilityAsk | undefined): void => {
		const uri = uriOf(file);

		// A new stop, or none: the rule being made at the last one goes.
		making.get(session)?.();
		making.delete(session);

		if (ask !== undefined) {
			const ran = sessions.get(uri);

			asks.set(uri, { "session": session, "ask": ask, "anchors": anchorsFor(file, source, ran?.id === session ? ran : undefined) });
		} else if (asks.get(uri)?.session === session) {
			asks.delete(uri);
		}

		redraw(uri);
	};

	/** The sessions that told an `ended`: their margins are cleared already. */
	const told = new Set<string>();

	// The run contract's events, from every debugger's sessions (ARCHITECTURE.md, *Extension points* 1).
	vscode.debug.onDidReceiveDebugSessionCustomEvent(({ session, event, body }) => {
		switch (event) {
			case "values":
				valuesCame(session.id, body as ValuesEvent);
				break;
			case "ended":
				told.add(session.id);
				endedCame(session.id, body as EndedEvent);
				break;
			case "coverage": {
				// (the statements it ran, in each file it ran: what a kept run is identified by)
				const executed = new Map<string, [[number, number], [number, number]][]>();

				for (const report of [body as CoverageEvent, ...(body as CoverageEvent).files ?? []]) {
					executed.set(report.file, report.statements.filter((statement) => statement.count > 0).map((statement) => [statement.start, statement.end]));
					// (what the run saw each function write outside itself: the latest run's, for the cards)
					impureOf.set(report.file, report.impure ?? []);
				}

				executedOf.set(session.id, executed);
				break;
			}

			case "tests":
				testsOf.set(session.id, body as TestsEvent);
				break;

			case "effects":
				// (what came in: a call made, or given a result — not one skipped or denied)
				inputsOf.set(session.id, (body as EffectsEvent).effects.filter((effect) => effect.how === "made" || effect.how === "given").map((effect) => inputOf(effect.capability, effect.resource)));
				break;
			case "ask": {
				const { file, source, ...question } = body as AskEvent;

				askCame(session.id, file, source, question);
				break;
			}

			default:
				break;
		}
	});

	// A debugger that tells no `ended`: the program's values end with its session. And a question no one answered here
	// goes with it.
	vscode.debug.onDidStartDebugSession((session) => {
		if (session.configuration["__live"] === true) {
			liveSessions.add(session.id);
		}
	});
	vscode.debug.onDidTerminateDebugSession((session) => {
		const { program } = session.configuration;

		const live = liveSessions.delete(session.id);

		// (after every event it told: its values, end and effects)
		void keepSession(session.id, live).catch((error: unknown) => {
			log?.warn("a run couldn't be kept", { "error": failureText(error) });
		});

		if (!told.delete(session.id) && session.type !== "production" && typeof program === "string") {
			endedCame(session.id, { "file": program });
		}

		for (const [uri, asking] of asks) {
			if (asking.session === session.id) {
				askCame(session.id, vscode.Uri.parse(uri).path, undefined, undefined);
			}
		}
	});
}
