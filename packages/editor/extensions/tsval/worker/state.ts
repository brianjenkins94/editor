/**
 * What the debug worker's modules share: its link into the editor, its log and its events to the adapter, the program
 * and its breakpoints, the machine running and its history of stops — and, on `state`, what more than one module
 * assigns. (A module can't assign another's `let`, so those are one object's properties.)
 */
import type { FsShim, RunGlobal } from "@brianjenkins94/almostnode";
import type { PlaceSet, TestReport } from "@brianjenkins94/editor-api";
import type { RuntimeConnection } from "@brianjenkins94/editor-api/runtime";
import type { LoadedVM } from "@brianjenkins94/tsval";
import type { WsConsumer } from "@brianjenkins94/util/silo/detect";
import type { BaselinePackages } from "@brianjenkins94/util/silo/evidence";
import type { Policy } from "@brianjenkins94/util/silo/policy";
import type { WorkerEvent } from "../debug-protocol";
import type { Runtime } from "./runtime";
import ts from "typescript";

/** This worker's log, once it's linked (always, by the time a control message comes: the link comes first). */
export function workerLog(): RuntimeConnection["log"] {
	return state.editorLink.log;
}

export type Vm = LoadedVM["vm"];

/** A span's cross-context trace context: the hub envelope of a control message that triggers work carries the
 *  adapter action's, so this worker's span continues the adapter's trace (see continueSpan). */
export interface TraceContext { "traceId": string; "parentSpanId": string }

export type Action = "continue" | "next" | "stepIn" | "stepOut" | "stepBack" | "reverseContinue" | "disconnect";

export type ForwardAction = "continue" | "next" | "stepIn" | "stepOut";

/** An event for the adapter, on this session's event subject. */
export function post(message: WorkerEvent): void {
	globalThis.postMessage(message);
}

/** Where the run is: a program file and a 1-based line in it — the entry's, or another of the program's (packages/tsval/README.md, *Modules*). */
export interface Place { "file": string; "line": number }

/** What more than one of the worker's modules assigns. */
export interface State {
	/** This worker's link into the editor's runtime (editor-api's workspace runtime), the port the adapter hands over
	 *  first thing: a server the program starts answers through it, and its log and spans — a step's, its uncaught
	 *  errors, its own requests — are the editor's, as this worker's (the top page's timeline, debug-mcp). The debug
	 *  protocol itself is the adapter's and this worker's own: their messages (debug-protocol.ts' ToWorker / WorkerEvent). */
	"editorLink": RuntimeConnection | undefined;
	/** The step under way's span (advanceFrom's): a run's end closes it before it says so (finish). */
	"stepSpan": { "end": () => void } | undefined;
	"sourceFile": ts.SourceFile | undefined;
	/** 1-based lines pre-armed as capability breakpoints (policy said stop), by program file — so a stop there reports
	 *  reason "capability" rather than "breakpoint". The entry's computed at launch from the policy the adapter sent;
	 *  another file's as it loads (noteProgramFile). */
	"capabilityLines": Map<string, Set<number>>;
	/** What rules placed in the code set, once the statement on the line's run: by file and 1-based line (bridge/placed-rules.ts). */
	"placeSets": Map<string, Map<number, PlaceSet[]>>;
	/** The program's files known so far — the entry, and each other one as it loads — parsed for their capability calls. */
	"programFiles": Map<string, ts.SourceFile>;
	/** The policy the run is under (the adapter's, updated after an "Allow always"); none, no capability stops. */
	"policy": Policy | undefined;
	/** The user's breakpoints (1-based lines), armed beside the capability lines. */
	"userLines": number[];
	/** The user's breakpoints in the program's other files (packages/tsval/README.md, *Modules*), by file. */
	"fileLines": Map<string, number[]>;
	/** "Deny" at a capability stop: the next capability call fails, as a denied one would. Reset at every stop. */
	"denyNext": boolean;
	/** The result the user gave the call at a capability stop, once (`decide` with `give`): the next stand-in call returns it. */
	"giveNext": { "value": unknown } | undefined;
	/** "Allow once" (or this run, or always) at a capability stop: the next capability call the policy doesn't allow happens
	 *  for real all the same — the one asked about. Reset at every stop. */
	"allowNext": boolean;
	/** The call at the capability stop the user skipped (RUNTIME-EVIDENCE.md, *Capability decisions, on the line*): it isn't made, the run goes on with its inert
	 *  stand-in's result. */
	"skipNext": boolean;
	/** How the call at the capability stop was decided — the person's answer there (an exception to the policy, on record in
	 *  the run's effects): taken by the next capability call, the one asked about. */
	"answeredNext": "once" | "always" | "refused" | undefined;
	/** Writes a program's allowed call is making right now: the runtime lets these through, a package's it refuses. */
	"allowingWrites": number;
	/** Forks, one per stop reached; `index` is the currently-displayed stop. */
	"history": Vm[];
	"index": number;
	"done": boolean;
	/** Resolver for the control message the session loop is currently awaiting (top-level, async pause). */
	"awaitAction": ((action: Action) => void) | undefined;
	/** Trace context of the control message currently being handled — so the step span it drives continues the
	 *  adapter's trace (one cross-context trace per debug action). Set just before the awaited action resolves. */
	"actionTrace": TraceContext | undefined;
	/**
	 * Shared control word for the SYNCHRONOUS in-handler pause. A breakpoint reached inside a host-invoked guest call
	 * (a server's request handler, a library's callback, a program file a package requires) can't pause by awaiting — the call is on a synchronous stack the worker
	 * loop doesn't drive — so the onBreakpoint hook blocks the whole worker on `Atomics.wait` while the main
	 * thread stays live, and the adapter resumes it via `Atomics.notify`. control[0]: 0 = waiting, 1 = go.
	 */
	"control": Int32Array | undefined;
	/** The VM on the timeline being shown — what coverage reports on. A forward step advances a fork; a step back
	 *  returns to an earlier stop. */
	"current": Vm | undefined;
	/** Where the run's event loop started (its clock then), for times shown since; and what a wait costs (Skip Waits). */
	"loopStart": number;
	"pace": "real" | "fast";
	/** A probe running (probeResource): the capability whose call it's after, and the resource that call reached. */
	"probing": { "capability": string; "resource"?: string } | undefined;
	/** The functions the program was given — its built-in modules (node:fs and the rest, the capability stand-ins among them)
	 *  and globals, two levels into each (`fs.promises.mkdir`): what a capability stop's call has to be one of to be one
	 *  (lineReaches). Set as a run starts. */
	"programFunctions": WeakSet<object>;
	/** The program's `process`, for the exit code it sets (`process.exitCode`) when it finishes on its own. */
	"guestProcess": { "exitCode"?: number } | undefined;
	/** The program's module system (packages/tsval/README.md, *Modules*): almostnode on the shared workspace — resolution, the module graph, the
	 *  cache — with tsval evaluating the program's own files (programModules). A package's built-ins are almostnode's, its
	 *  writes refused (a library's effects aren't stepped or asked about); the program's are its stand-ins (programBuiltins:
	 *  what a capability stop is about). Loaded at a run's start. */
	"runtime": Runtime | undefined;
	/** The program's own `fs` for a run in `cwd`: almostnode's over the editor's runtime files (runtime-vfs.ts) — each of
	 *  its calls on a workspace file the editor's to decide, make and keep among the run's effects, as any debugger's
	 *  program's are. Undefined outside the editor (no runtime link): the program's `fs` is then the runtime's own. */
	"programFsFor": ((cwd: string) => FsShim) | undefined;
	/** The globals the program has on Node beyond ECMAScript's (workspace-runtime.ts' programGlobals), once the runtime's up. */
	"nodeGlobals": Record<string, unknown>;
	/** The run's own global, as a Node process has one (almostnode's run-global.ts): its packages' `globalThis`, and the
	 *  program's names that only they set (sharedGlobals) — so what a package does to its globals (just-bash's sandbox
	 *  puts Proxies over `performance` and the timers) is the run's, not this worker's, whose are the debugger's. */
	"runGlobal": RunGlobal | undefined;
	/** The built-ins the program's code gets (the run's capability stand-ins, by name) — set as a run starts. */
	"programBuiltins": Record<string, unknown>;
	/** The machine evaluating the program: a program file a package requires is evaluated on it (a nested run). */
	"evaluating": Vm | undefined;
	/** almostnode's `packageDirOf`, once the runtime's loaded. */
	"packageDirOf": ((filename: string) => string | undefined) | undefined;
	/** The dependency baseline (`.silo/baseline.json`, read as a run starts): what the part of each package the code uses
	 *  could reach when it began to (the join, its `consumer`), and what each package's own code could do when the library
	 *  was added (its `packages`) — what grew since isn't settled: it asks, unless the policy allows it. Undefined when
	 *  there's none (the editor makes it as a project opens, unless `silo.baseline` is off): the policy decides every
	 *  package's call. */
	"baseline": { "consumer"?: Record<string, WsConsumer>; "packages"?: BaselinePackages } | undefined;
	/** The version the editor pins of each package (`.silo/versions.json`, read as a run starts): what's installed. */
	"pins": Record<string, string>;
	/** The tests a test file's run ran, as each ended (node-test.js tells each start and end). */
	"testsRan": TestReport[];
	/** How many tests failed, as node-test.js tells at the end: a run with one fails, as `node --test` does. */
	"testsFailed": number;
	/** Whether node-test.js has told that the file's tests are all done: past it, only what Node counts as keeping a process
	 *  alive keeps the run going (advanceFrom). */
	"testsDone": boolean;
}

export const state: State = {
	"editorLink": undefined,
	"stepSpan": undefined,
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
	"programFunctions": new WeakSet<object>(),
	"guestProcess": undefined,
	"runtime": undefined,
	"programFsFor": undefined,
	"nodeGlobals": {},
	"runGlobal": undefined,
	"programBuiltins": {},
	"evaluating": undefined,
	"packageDirOf": undefined,
	"baseline": undefined,
	"pins": {},
	"testsRan": [],
	"testsFailed": 0,
	"testsDone": false
};
