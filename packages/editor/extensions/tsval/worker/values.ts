import type { TraceEvent } from "@brianjenkins94/tsval";
import type { Told, Traced } from "@brianjenkins94/editor-api/values";
import type { Vm } from "./state";
import { LiveRecord } from "@brianjenkins94/editor-api/values";
import ts from "typescript";
import { EDITOR_SOURCES } from "./runtime";
import { rangeOf } from "./session";
import { post, state } from "./state";

const live = new Map<ts.SourceFile, LiveRecord>();
const toldSource = new Set<string>();
const toldAt = new WeakMap<Vm, Map<LiveRecord, Told>>();
const tracedAt = new WeakMap<ts.Node, { "file": ts.SourceFile; "line": number; "at": [number, number] }>();
const calleeAt = new WeakMap<ts.Node, NonNullable<Traced["callee"]>>();
const loopTurns = new WeakMap<TraceEvent["loops"], number[]>();

let timer: ReturnType<typeof setInterval> | undefined;
let flushedAt = 0;
let tracedSince = 0;
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

export function flushValues(): void {
	flushedAt = Date.now();

	for (const [file, record] of live) {
		const batch = record.drain();

		if (batch !== undefined && !EDITOR_SOURCES.has(file.fileName)) {
			const other = file === state.sourceFile ? {} : { "file": file.fileName, ...toldSource.has(file.fileName) ? {} : { "source": file.text } };

			toldSource.add(file.fileName);
			post({ "type": "values", "batch": batch, ...other });
		}
	}
}

export function traceValue(event: TraceEvent): void {
	if (state.sourceFile === undefined || state.probing !== undefined || event.name.startsWith("__self.__replay")) {
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

export function tellSkipped(capability: string, resource: string): void {
	const vm = state.evaluating;
	const node = vm?.currentNode;

	if (vm !== undefined && node !== null && node !== undefined) {
		const file = node.getSourceFile();

		liveIn(file).add({ "line": file.getLineAndCharacterOfPosition(node.getStart(file)).line, "name": "skipped", "value": resource === "" ? capability : `${capability} ${resource}`, "kind": "skip", ...whereNow(vm), "step": vm.statements, "at": rangeOf(node) });
	}
}

export function tellReplayed(capability: string, resource: string): void {
	const vm = state.evaluating;
	const node = vm?.currentNode;

	if (vm !== undefined && node !== null && node !== undefined) {
		const file = node.getSourceFile();

		liveIn(file).add({ "line": file.getLineAndCharacterOfPosition(node.getStart(file)).line, "name": "replayed", "value": resource === "" ? capability : `${capability} ${resource}`, "kind": "given", ...whereNow(vm), "step": vm.statements, "at": rangeOf(node) });
	}
}

export function tellSet(vm: Vm, name: string, value: unknown, line?: number): void {
	const at = vm.location();

	if (at !== null && vm.currentNode !== null) {
		liveIn(vm.currentNode.getSourceFile()).add({ "line": line ?? at.line, "name": name, "value": "", "raw": value, "kind": "set", "call": lastTraced?.call ?? 0, "turns": lastTraced?.turns ?? [], "step": lastTraced?.step ?? 0, "at": rangeOf(vm.currentNode) });
		flushValues();
	}
}

export function keepTold(vm: Vm): void {
	toldAt.set(vm, new Map([...live.values()].map((record) => [record, record.told()])));
}

export function resumeTold(vm: Vm): void {
	for (const record of live.values()) {
		record.resume(toldAt.get(vm)?.get(record));
	}
}

export function startValues(): void {
	live.clear();
	toldSource.clear();
	lastTraced = undefined;
	timer = setInterval(flushValues, 250);
}

export function endValues(): void {
	clearInterval(timer);
	flushValues();
}
