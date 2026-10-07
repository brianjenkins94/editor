/**
 * The tsval debugger's adapter ⇄ worker protocol, over the pod hub. Each session has two subjects: control goes DOWN
 * (`debug.session.<id>.control`, adapter → worker) and events come UP (`debug.session.<id>.event`, worker → adapter),
 * so several sessions share the pod hub without crossing. A control message that starts work carries the adapter
 * action's trace context in the hub envelope, so the worker's step continues that trace. The React render stream goes
 * straight to the render surface on `tsval.preview.stream` (see tsval-surface.ts), not through the adapter.
 *
 * The one thing that isn't a message: resuming from a breakpoint inside a host-invoked guest call (a React handler).
 * The worker is blocked in Atomics.wait there, so the adapter resumes it through the shared control word it sent at
 * launch.
 */
import type { Policy, Rule } from "@brianjenkins94/util/silo/policy";
import type { LiveBatch } from "./live-values";

export const controlSubject = (session: string): string => "debug.session." + session + ".control";
export const eventSubject = (session: string): string => "debug.session." + session + ".event";
/** The render surface's stream (mutations, rendered, history, reset). */
export const PREVIEW_STREAM = "tsval.preview.stream";

export type StepAction = "continue" | "next" | "stepIn" | "stepOut" | "stepBack" | "reverseContinue";

/** Adapter → worker. */
export type Control =
	| { "type": "launch"; "source": string; "fileName": string; "lines": number[]; "control"?: SharedArrayBuffer; "react"?: boolean; "policy"?: Policy; "args"?: string[]; "program"?: string; "hooks"?: SetHook[]; "eventLoop"?: LoopStart; "files"?: Record<string, number[]>; "workspace"?: SharedArrayBuffer }
	/** Run every ordering of the program's events (tsval's explore) instead of debugging it: answered with `explored`. */
	| { "type": "explore"; "source": string; "fileName": string; "policy"?: Policy; "args"?: string[]; "eventLoop": LoopStart; "maxRuns"?: number; "workspace"?: SharedArrayBuffer }
	/** The user's breakpoints in a file: the program's entry, or (`file`) another of its files. */
	| { "type": "setBreakpoints"; "lines": number[]; "file"?: string }
	| { "type": "dispatch"; "id": number; "event": string }
	| { "type": "timeTravel"; "index": number }
	/** Report the coverage so far (answered with a `coverage` event). */
	| { "type": "coverage" }
	/** A decision at a capability stop, before the run resumes: `deny` fails the call the stop was for; `policy`, after
	 *  "Allow always", is the policy now in effect — what stops from here on; `give`, the result the call returns instead
	 *  of being made (a rule's *give result*, just this once). */
	| { "type": "decide"; "deny"?: boolean; "policy"?: Policy; "give"?: unknown }
	/** At a stop: set `name` (a variable in scope there) to `value`, a literal as code writes it — the run goes on with it. */
	| { "type": "setValue"; "name": string; "value": string }
	/** What a timer's wait costs from here on: its real delay, or none (Skip Waits). */
	| { "type": "pace"; "pace": "real" | "fast" }
	/** Input for the program's process.stdin (typed in the Debug Console). */
	| { "type": "stdin"; "data": string }
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
export interface SetHook { "line": number; "place": unknown; "rule": Rule }

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
export interface CapabilityAsk { "line": number; "at"?: [number, number]; "capability": string; "callee": string; "resource": string; "resolved": boolean; "dangerous": boolean }

/** How a run ended short, for the notes margin's strip: the line (0-based) it crashed on, with the error, or the one it
 *  was stopped at. A run that finished has none. */
export interface RunEnd { "kind": "crashed" | "stopped"; "line": number; "at"?: [number, number]; "message"?: string }

/** The choices at a capability stop, as the preview's prompt words them — and `rule`, a rule made there (the margin's
 *  rule editor) saved in my policy, deciding the call as it does (or giving its result); `give-once`, a result given the
 *  call instead of it, just this once; `allow-run`, calls like it allowed until the run ends (kept nowhere). */
export type CapabilityChoice = "allow-once" | "allow-run" | "allow-always" | "deny" | "rule" | "give-once";

/** Worker → adapter. */
export type WorkerEvent =
	| { "type": "stopped"; "reason": string; "snapshot": Snapshot; "atomic"?: boolean; "ask"?: CapabilityAsk }
	/** The program is over: `exitCode` 1 when it threw, else 0. */
	| { "type": "terminated"; "exitCode"?: number; "crash"?: { "line": number; "at": [number, number]; "message": string } }
	| { "type": "output"; "text": string; "stream"?: "stdout" | "stderr" }
	| { "type": "rendered" }
	| { "type": "history"; "length": number }
	/** The program's statement coverage — asked for, or `final` just before `terminated`. */
	| { "type": "coverage"; "report": CoverageReport; "final"?: boolean }
	/** The session's live values new since the last (live-values.ts): a few times a second, and before a stop or the end. */
	| { "type": "values"; "batch": LiveBatch }
	/** A `setValue` done (the new value as the Variables view shows it, and the stop's snapshot with it), or refused. */
	| { "type": "valueSet"; "ok": boolean; "value"?: string; "error"?: string; "snapshot"?: Snapshot }
	/** What exploring the program's orderings found (asked by `explore`). */
	| { "type": "explored"; "explored": Explored }
	/** A server the program started listens on `port` (it answers the preview there). */
	| { "type": "listening"; "port": number }
	/** Out of work, serving: the session is idle until a request (or a timer) comes. */
	| { "type": "serving"; "ports": number[] };

/** One statement's coverage: its range (0-based line and character, as VS Code's Position) and how often it ran. */
export interface StatementCoverage {
	"start": [number, number];
	"end": [number, number];
	"count": number;
	/** What anchors it on the code (offsets in the text that ran): its head for a statement with a body — an `if`'s
	 *  condition, a function's name — whose span outlives a reformat inside the body (a body's span changes with any
	 *  token in it, a semicolon dropped say); the statement itself otherwise. */
	"anchor"?: [number, number];
}

/** A top-level statement's share of the run (tsval's profile) — a function's or class's declaration too: its range and
 *  anchor (as a statement's coverage has), the steps run in its code, the virtual time waited before its code ran again,
 *  and the step it first ran at. */
export interface StatementProfile { "start": [number, number]; "anchor": [number, number]; "steps": number; "waited": number; "first": number }

/** What went through one observed site (tsval's `observe`; RUNTIME-EVIDENCE.md, the second slice), over a run: its
 *  kind and its node's range, then — for a value site — how often a value came through, how often it was nullish, how
 *  often each type tag, and a few distinct primitives (kept on this machine, never committed); for a branch, how often
 *  each arm ran. */
export interface SiteObservation {
	"site": "optional" | "nullish" | "branch" | "parameter" | "return";
	"start": [number, number];
	"end": [number, number];
	"seen"?: number;
	"nullish"?: number;
	"tags"?: Record<string, number>;
	"samples"?: (string | number | boolean)[];
	"arms"?: number[];
}

/** Every statement tsval can run in the program, with how often each ran — 0 for the ones that never did — and every
 *  observed site that ran: the entry's, and (`files`) each other program file's that ran, with its source. The body of the adapter's `getCoverage` reply and of its `coverage` event. */
export interface CoverageReport { "file": string; "statements": StatementCoverage[]; "sites": SiteObservation[]; "source"?: string; "profile"?: StatementProfile[]; "files"?: CoverageReport[] }

/** Worker → render surface (`PREVIEW_STREAM`); `reset` comes from the workbench bridge at session start. */
export type PreviewMessage =
	| { "type": "mutation"; "mutation": unknown }
	| { "type": "rendered" }
	| { "type": "history"; "length": number }
	| { "type": "reset" };
