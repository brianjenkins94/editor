/**
 * The run's live values (RUNTIME-EVIDENCE.md, *Live values*): what each line bound, returned or chose, from tsval's trace,
 * told to the adapter a few times a second and before each stop and the end, by the program file they're in, each its
 * own record.
 */
import type { TraceEvent } from "@brianjenkins94/tsval";
import type { Told, Traced } from "@brianjenkins94/editor-api/values";
import type { Vm } from "./state";
import { LiveRecord } from "@brianjenkins94/editor-api/values";
import ts from "typescript";
import { EDITOR_SOURCES } from "./runtime";
import { rangeOf } from "./session";
import { post, state } from "./state";

const live = new Map<ts.SourceFile, LiveRecord>();
/** The program's files whose text the adapter has been told (with their first values): the entry's it has. */
const toldSource = new Set<string>();
/** Each stop's place in each record's telling, for a run that goes on from that stop again. */
const toldAt = new WeakMap<Vm, Map<LiveRecord, Told>>();
/** Each traced node's file, line and range, read once: a node is traced each time it runs. */
const tracedAt = new WeakMap<ts.Node, { "file": ts.SourceFile; "line": number; "at": [number, number] }>();
/** Each call's function as the values name it, read once. */
const calleeAt = new WeakMap<ts.Node, NonNullable<Traced["callee"]>>();
/** The turns of a trace's loops, read once: tsval shares one loops array among a turn's events. */
const loopTurns = new WeakMap<TraceEvent["loops"], number[]>();

let timer: ReturnType<typeof setInterval> | undefined;
/** When the values were last told, and how many were traced since the clock was last read: a run holds the worker while
 *  it goes, so the interval can't fire, and the trace tells them too, every quarter second. */
let flushedAt = 0;
let tracedSince = 0;
/** Where the last value was: a value told by something other than the trace goes in the same turn. */
let lastTraced: { "call": number; "turns": number[]; "step": number } | undefined;

function liveIn(file: ts.SourceFile): LiveRecord {
	let record = live.get(file);

	if (record === undefined) {
		record = new LiveRecord();
		live.set(file, record);
	}

	return record;
}

function tracedPlace(node: ts.Node): { "file": ts.SourceFile; "line": number; "at": [number, number] } {
	let place = tracedAt.get(node);

	if (place === undefined) {
		const file = node.getSourceFile();

		place = { "file": file, "line": file.getLineAndCharacterOfPosition(node.getStart(file)).line, "at": rangeOf(node) };
		tracedAt.set(node, place);
	}

	return place;
}

/** A function's name: its own, or the variable it's assigned to. */
function calleeName(node: ts.Node): string {
	const named = (node as { "name"?: ts.Node }).name;

	if (named !== undefined && (ts.isIdentifier(named) || ts.isPrivateIdentifier(named))) {
		return named.text;
	}

	return ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name) ? node.parent.name.text : "anonymous";
}

function calleeOf(node: ts.Node): NonNullable<Traced["callee"]> {
	let callee = calleeAt.get(node);

	if (callee === undefined) {
		const { line, at } = tracedPlace(node);

		callee = { "name": calleeName(node), "line": line, "at": at };
		calleeAt.set(node, callee);
	}

	return callee;
}

function turnsOf(loops: TraceEvent["loops"]): number[] {
	let turns = loopTurns.get(loops);

	if (turns === undefined) {
		turns = loops.map((loop) => loop.turn);
		loopTurns.set(loops, turns);
	}

	return turns;
}

/** Tell the adapter the values new since it was last told. */
export function flushValues(): void {
	flushedAt = Date.now();

	for (const [file, record] of live) {
		const batch = record.drain();

		if (batch !== undefined && !EDITOR_SOURCES.has(file.fileName)) {
			// Another of the program's files: which, and its text the first time (what its values' ranges are in).
			const other = file === state.sourceFile ? {} : { "file": file.fileName, ...toldSource.has(file.fileName) ? {} : { "source": file.text } };

			toldSource.add(file.fileName);
			post({ "type": "values", "batch": batch, ...other });
		}
	}
}

/** What tsval's trace told (VMOptions.trace). */
export function traceValue(event: TraceEvent): void {
	// (a probe's fork didn't run)
	if (state.sourceFile === undefined || state.probing !== undefined) {
		return;
	}

	const place = tracedPlace(event.node);
	const traced: Traced = { "line": place.line, "name": event.name, "value": "", "raw": event.value, "kind": event.kind, "call": event.call, "turns": turnsOf(event.loops), "step": event.step, "at": place.at };

	if (event.callee !== undefined) {
		traced.callee = calleeOf(event.callee);
	}

	lastTraced = traced;
	liveIn(place.file).add(traced);
	tracedSince += 1;

	if (tracedSince >= 1024) {
		tracedSince = 0;

		if (Date.now() - flushedAt >= 250) {
			flushValues();
		}
	}
}

/** The call and loop turns `vm` is in. */
function whereNow(vm: Vm): { "call": number; "turns": number[] } {
	const turns: number[] = [];

	for (let index = vm.frames.length - 1; index >= 0; index--) {
		const frame = vm.frames[index] as { "kind"?: string; "call"?: number; "isLoop"?: boolean; "turn"?: number };

		if (frame.kind === "call" || frame.kind === "construct") {
			return { "call": frame.call ?? 0, "turns": turns.toReversed() };
		}

		if (frame.kind === undefined && frame.isLoop === true && frame.turn !== undefined) {
			turns.push(frame.turn);
		}
	}

	return { "call": 0, "turns": turns.toReversed() };
}

/** A call skipped at its stop, told on its line as a value of its own: the margin says what didn't happen there. */
export function tellSkipped(capability: string, resource: string): void {
	const vm = state.evaluating;
	const node = vm?.currentNode;

	if (vm !== undefined && node !== null && node !== undefined) {
		const file = node.getSourceFile();

		liveIn(file).add({ "line": file.getLineAndCharacterOfPosition(node.getStart(file)).line, "name": "skipped", "value": resource === "" ? capability : `${capability} ${resource}`, "kind": "skip", ...whereNow(vm), "step": vm.statements, "at": rangeOf(node) });
	}
}

/** A value set by hand at the stop `vm` is at, or by a rule placed on `line` (0-based), shown with the run's values. */
export function tellSet(vm: Vm, name: string, value: unknown, line?: number): void {
	const at = vm.location();

	if (at !== null && vm.currentNode !== null) {
		liveIn(vm.currentNode.getSourceFile()).add({ "line": line ?? at.line, "name": name, "value": "", "raw": value, "kind": "set", "call": lastTraced?.call ?? 0, "turns": lastTraced?.turns ?? [], "step": lastTraced?.step ?? 0, "at": rangeOf(vm.currentNode) });
		flushValues();
	}
}

/** A stop kept, to go on from: where the telling was. */
export function keepTold(vm: Vm): void {
	toldAt.set(vm, new Map([...live.values()].map((record) => [record, record.told()])));
}

/** A run going on from the stop `vm`: after a step back, the values it tells again are replays. */
export function resumeTold(vm: Vm): void {
	for (const record of live.values()) {
		record.resume(toldAt.get(vm)?.get(record));
	}
}

/** A launch: nothing told yet, and telling a few times a second. */
export function startValues(): void {
	live.clear();
	toldSource.clear();
	lastTraced = undefined;
	timer = setInterval(flushValues, 250);
}

/** The run's end: the last of them told. */
export function endValues(): void {
	clearInterval(timer);
	flushValues();
}
