/**
 * The tsval debugger's adapter ⇄ worker protocol, over the pod hub. Each session has two subjects: control goes DOWN
 * (`debug.session.<id>.control`, adapter → worker) and events come UP (`debug.session.<id>.event`, worker → adapter),
 * so several sessions share the pod hub without crossing. A control message that starts work carries the adapter
 * action's trace context in the hub envelope, so the worker's step continues that trace.
 *
 * The one thing that isn't a message: resuming from a breakpoint inside a host-invoked guest call (a server's handler,
 * a library's callback).
 * The worker is blocked in Atomics.wait there, so the adapter resumes it through the shared control word it sent at
 * launch.
 */
import type { CoverageEvent, Effect } from "@brianjenkins94/run-contract";
import type { Policy, Rule } from "@brianjenkins94/util/silo/policy";
import type { LiveBatch } from "./live-values";
import type { Replay } from "./page-evidence";

// The run contract's own (what a debugger tells the editor), as tsval's worker and adapter speak it too.
export type { RunEnd, SiteObservation, StatementCoverage, StatementProfile } from "@brianjenkins94/run-contract";

export const controlSubject = (session: string): string => "debug.session." + session + ".control";
export const eventSubject = (session: string): string => "debug.session." + session + ".event";

export type StepAction = "continue" | "next" | "stepIn" | "stepOut" | "stepBack" | "reverseContinue";

/** Where a program threw: its line and range — in `file`, when that's another of its files than the entry. */
/** How a run ended short: an uncaught error where it was thrown — or, `stopped`, where a live run ran out of budget. */
export interface Crash { "line": number; "at": [number, number]; "message": string; "file"?: string; "stopped"?: true }

/** Adapter → worker. */
export type Control =
	| { "type": "launch"; "source": string; "fileName": string; "lines": number[]; "control"?: SharedArrayBuffer; "policy"?: Policy; "args"?: string[]; "program"?: string; "hooks"?: SetHook[]; "eventLoop"?: LoopStart; "files"?: Record<string, number[]>; "workspace"?: SharedArrayBuffer; "cwd"?: string; "env"?: Record<string, string>; "replay"?: Replay; "live"?: boolean }
	/** Run every ordering of the program's events (tsval's explore) instead of debugging it: answered with `explored`. */
	| { "type": "explore"; "source": string; "fileName": string; "policy"?: Policy; "args"?: string[]; "eventLoop": LoopStart; "maxRuns"?: number; "workspace"?: SharedArrayBuffer }
	/** The user's breakpoints in a file: the program's entry, or (`file`) another of its files. */
	| { "type": "setBreakpoints"; "lines": number[]; "file"?: string }
	/** Report the coverage so far (answered with a `coverage` event). */
	| { "type": "coverage" }
	/** A decision at a capability stop, before the run resumes: `deny` fails the call the stop was for; `policy`, after
	 *  "Allow always", is the policy now in effect — what stops from here on; `give`, the result the call returns instead
	 *  of being made (a rule's *give result*, just this once). */
	| { "type": "decide"; "deny"?: boolean; "skip"?: boolean; "policy"?: Policy; "give"?: unknown }
	/** At a stop: set `name` (a variable in scope there) to `value`, a literal as code writes it — the run goes on with it. */
	| { "type": "setValue"; "name": string; "value": string }
	/** What a timer's wait costs from here on: its real delay, or none (Skip Waits). */
	| { "type": "pace"; "pace": "real" | "fast" }
	/** Input for the program's process.stdin (typed in the Debug Console). */
	/** The program's input — or (`end`) its end, as a terminal's Ctrl-D. */
	| { "type": "stdin"; "data": string; "end"?: boolean }
	| { "type": StepAction | "disconnect" };

/** Where tsval's event loop starts (its clock, its random seed) and — to run one ordering again — the choices to make. */
export interface LoopStart { "now": number; "seed": number; "schedule"?: number[] }

/** One way a run of the program can end, from exploring its orderings: what it printed, how it crashed if it did, a
 *  schedule that gets there (to debug it), the events chosen along it, and how many runs ended this way. */
export interface Ordering { "output": string[]; "crash"?: string; "schedule": number[]; "path": string[]; "runs": number }

/** What exploring a program's orderings found: how many runs, whether every ordering was run, and the distinct outcomes. */
export interface Explored { "runs": number; "complete": boolean; "outcomes": Ordering[]; "eventLoop": LoopStart }

/** A rule placed in the code (RULES.md: at, a span reference), found in the text that runs: the 1-based line its
 *  statement starts on, the place, and the rule — whose `set`s are made each time that statement has run, if it
 *  matches there. */
/** A rule's hook: the statement it sets after, by 1-based line — in `file` when that's another of the program's files
 *  than the entry. */
export interface SetHook { "line": number; "place": unknown; "rule": Rule; "file"?: string }

export interface Variable { "name": string; "value": string; "type": string; "variablesReference": number }

/** A stop, complete enough that the adapter answers stackTrace/scopes/variables with no round-trip. */
export interface Snapshot {
	/** `file`: the program file the frame is in (the entry when absent); `code`: its line's text. */
	"frames": { "id": number; "name": string; "line": number; "column": number; "at"?: [number, number]; "file"?: string; "code"?: string }[];
	"scopes": Record<number, { "name": string; "variablesReference": number; "expensive": boolean }[]>;
	"variables": Record<number, Variable[]>;
	/** True when this stop is an earlier point in history (a time-travel view), for the stop reason. */
	"traveled"?: boolean;
}

/** What a capability stop asks (LIVE-VALUES.md, step 8): the gated call on the line it stopped at — its capability,
 *  its callee as written, and the resource it would reach, from the run's own values where they're known by then (a
 *  literal, a variable's value), else the argument as written. `line` is 0-based. */
/** `file`: the program file the call is in, with its text (`source`), when it isn't the entry. */
export interface CapabilityAsk { "line": number; "at"?: [number, number]; "capability": string; "callee": string; "resource": string; "resolved": boolean; "dangerous": boolean; "file"?: string; "source"?: string }

/** The choices at a capability stop, as the preview's prompt words them — and `rule`, a rule made there (the margin's
 *  rule editor) saved in my policy, deciding the call as it does (or giving its result); `give-once`, a result given the
 *  call instead of it, just this once; `allow-run`, calls like it allowed until the run ends (kept nowhere). */
export type CapabilityChoice = "allow-once" | "allow-run" | "allow-always" | "skip" | "skip-run" | "skip-always" | "deny" | "deny-run" | "deny-always" | "rule" | "give-once";

/** Worker → adapter. */
export type WorkerEvent =
	| { "type": "stopped"; "reason": string; "snapshot": Snapshot; "atomic"?: boolean; "ask"?: CapabilityAsk }
	/** The program is over: `exitCode` 1 when it threw, else 0. */
	/** `crash.file`: where it threw, when that's another of the program's files than the entry. */
	| { "type": "terminated"; "exitCode"?: number; "crash"?: Crash; "quiet"?: true }
	/** The run's effects so far — each gated call made, denied, skipped or given — told with its coverage, for its envelope
	 *  in the run ledger (each telling has them all). */
	| { "type": "effects"; "effects": Effect[] }
	| { "type": "output"; "text": string; "stream"?: "stdout" | "stderr" }
	/** The program's statement coverage — asked for, or `final` just before `terminated`. */
	| { "type": "coverage"; "report": CoverageReport; "final"?: boolean }
	/** The session's live values new since the last (live-values.ts): a few times a second, and before a stop or the end. */
	/** What an allowed capability call returned (RUNNING.md, step 2), for the adapter to record (RULES.md, slice 2). */
	| { "type": "recorded"; "capability": string; "resource": string; "value": string }
	/** Live values, of the entry — or (`file`) another of the program's files, with its text (`source`) the first time. */
	| { "type": "values"; "batch": LiveBatch; "file"?: string; "source"?: string }
	/** A `setValue` done (the new value as the Variables view shows it, and the stop's snapshot with it), or refused. */
	| { "type": "valueSet"; "ok": boolean; "value"?: string; "error"?: string; "snapshot"?: Snapshot }
	/** What exploring the program's orderings found (asked by `explore`). */
	| { "type": "explored"; "explored": Explored }
	/** A server the program started listens on `port` (it answers the preview there). */
	| { "type": "listening"; "port": number }
	/** Out of work, serving: the session is idle until a request (or a timer) comes. */
	| { "type": "serving"; "ports": number[] };

/** Coverage, and the observed sites, as the run contract has them (@brianjenkins94/run-contract): the body of the
 *  adapter's `getCoverage` reply and of its `coverage` event. */
export type CoverageReport = CoverageEvent;

