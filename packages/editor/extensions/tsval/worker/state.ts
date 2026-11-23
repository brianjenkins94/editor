import type { FsShim, RunGlobal } from "@brianjenkins94/almostnode";
import type { PlaceSet, TestReport } from "@brianjenkins94/editor-api";
import type { layered, RuntimeConnection } from "@brianjenkins94/editor-api/runtime";
import type { LoadedVM } from "@brianjenkins94/tsval";
import type { Span } from "@brianjenkins94/util/logger";
import type { WsConsumer } from "@brianjenkins94/util/silo/detect";
import type { BaselinePackages } from "@brianjenkins94/util/silo/evidence";
import type { Policy } from "@brianjenkins94/util/silo/policy";
import type ts from "typescript";
import type { WorkerEvent } from "../debug-protocol";
import type { SiteSums } from "../site-sums";
import type { Local } from "./loopback";
import type { Runtime } from "./runtime";

export function workerLog(): RuntimeConnection["log"] {
	return state.editorLink.log;
}

const linkCalls = new Map<string, { "calls": number; "ms": number; "failed": number }>();

export function countLinkCalls(link: RuntimeConnection): RuntimeConnection {
	const counted = <T extends (...args: never[]) => unknown>(what: string, call: T): T => ((...args: Parameters<T>) => {
		const started = performance.now();
		const tally = linkCalls.get(what) ?? { "calls": 0, "ms": 0, "failed": 0 };

		linkCalls.set(what, tally);
		tally.calls += 1;

		try {
			return call(...args);
		} catch (error) {
			tally.failed += 1;

			throw error;
		} finally {
			tally.ms += performance.now() - started;
		}
	}) as T;

	for (const [name, call] of Object.entries(link.fs)) {
		(link.fs as unknown as Record<string, unknown>)[name] = counted(name, call);
	}

	link.tarball = counted("tarball", link.tarball);
	link.decide = counted("decide", link.decide);

	return link;
}

export function linkCallsSince(): Record<string, number> {
	const told = Object.fromEntries([...linkCalls].flatMap(([what, { calls, ms, failed }]) => [
		[what, calls],
		[what + "Ms", Math.round(ms)],
		...failed > 0 ? [[what + "Failed", failed]] : []
	]));

	linkCalls.clear();

	return told;
}

export type Vm = LoadedVM["vm"];

export interface TraceContext { "traceId": string; "parentSpanId": string }

export type Action = "continue" | "next" | "stepIn" | "stepOut" | "stepBack" | "reverseContinue" | "disconnect";

export type ForwardAction = "continue" | "next" | "stepIn" | "stepOut";

export function post(message: WorkerEvent): void {
	globalThis.postMessage(message);
}

export interface Place { "file": string; "line": number }

export interface State {
	"editorLink": RuntimeConnection | undefined;
	"stepSpan": { "end": () => void } | undefined;
	"runSpan": Span | undefined;
	"sourceFile": ts.SourceFile | undefined;
	"capabilityLines": Map<string, Set<number>>;
	"placeSets": Map<string, Map<number, PlaceSet[]>>;
	"programFiles": Map<string, ts.SourceFile>;
	"live": boolean;
	"recordedResults": Record<string, unknown>;
	"runLayer": ReturnType<typeof layered> | undefined;
	"policy": Policy | undefined;
	"userLines": number[];
	"fileLines": Map<string, number[]>;
	"denyNext": boolean;
	"giveNext": { "value": unknown } | undefined;
	"allowNext": boolean;
	"skipNext": boolean;
	"answeredNext": "once" | "always" | "refused" | undefined;
	"allowingWrites": number;
	"history": Vm[];
	"index": number;
	"done": boolean;
	"awaitAction": ((action: Action) => void) | undefined;
	"actionTrace": TraceContext | undefined;
	"control": Int32Array | undefined;
	"current": Vm | undefined;
	"sumsOf": WeakMap<Vm, SiteSums>;
	"recording": SiteSums;
	"loopStart": number;
	"pace": "real" | "fast";
	"probing": { "capability": string; "argIndex"?: number; "resource"?: string } | undefined;
	"programFunctions": WeakSet<object>;
	"guestProcess": { "exitCode"?: number } | undefined;
	"runtime": Runtime | undefined;
	"programFsFor": ((cwd: string) => FsShim) | undefined;
	"local": Local | undefined;
	"runEval": ((source: unknown) => unknown) | undefined;
	"nodeGlobals": Record<string, unknown>;
	"runGlobal": RunGlobal | undefined;
	"programBuiltins": Record<string, unknown>;
	"evaluating": Vm | undefined;
	"packageDirOf": ((filename: string) => string | undefined) | undefined;
	"baseline": { "consumer"?: Record<string, WsConsumer>; "packages"?: BaselinePackages } | undefined;
	"pins": Record<string, string>;
	"testsRan": TestReport[];
	"windowReach": TestReport["files"];
	"testsFailed": number;
	"testsDone": boolean;
}

export const state: State = {
	"editorLink": undefined,
	"stepSpan": undefined,
	"runSpan": undefined,
	"sourceFile": undefined,
	"capabilityLines": new Map<string, Set<number>>(),
	"placeSets": new Map<string, Map<number, PlaceSet[]>>(),
	"programFiles": new Map<string, ts.SourceFile>(),
	"policy": undefined,
	"userLines": [],
	"fileLines": new Map<string, number[]>(),
	"denyNext": false,
	"giveNext": undefined,
	"allowNext": false,
	"skipNext": false,
	"answeredNext": undefined,
	"allowingWrites": 0,
	"history": [],
	"index": -1,
	"done": false,
	"awaitAction": undefined,
	"actionTrace": undefined,
	"control": undefined,
	"current": undefined,
	"loopStart": 0,
	"pace": "real",
	"probing": undefined,
	"sumsOf": new WeakMap(),
	"recording": new Map(),
	"programFunctions": new WeakSet<object>(),
	"guestProcess": undefined,
	"runtime": undefined,
	"programFsFor": undefined,
	"local": undefined,
	"runEval": undefined,
	"live": false,
	"recordedResults": {},
	"runLayer": undefined,
	"nodeGlobals": {},
	"runGlobal": undefined,
	"programBuiltins": {},
	"evaluating": undefined,
	"packageDirOf": undefined,
	"baseline": undefined,
	"pins": {},
	"testsRan": [],
	"windowReach": [],
	"testsFailed": 0,
	"testsDone": false
};
