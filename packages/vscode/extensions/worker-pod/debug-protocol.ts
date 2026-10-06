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
	| { "type": "launch"; "source": string; "fileName": string; "lines": number[]; "control"?: SharedArrayBuffer; "react"?: boolean; "policy"?: Policy; "args"?: string[]; "program"?: string; "hooks"?: SetHook[] }
	| { "type": "setBreakpoints"; "lines": number[] }
	| { "type": "dispatch"; "id": number; "event": string }
	| { "type": "timeTravel"; "index": number }
	/** Report the coverage so far (answered with a `coverage` event). */
	| { "type": "coverage" }
	/** A decision at a capability stop, before the run resumes: `deny` fails the call the stop was for; `policy`, after
	 *  "Allow always", is the policy now in effect — what stops from here on. */
	| { "type": "decide"; "deny"?: boolean; "policy"?: Policy }
	/** At a stop: set `name` (a variable in scope there) to `value`, a literal as code writes it — the run goes on with it. */
	| { "type": "setValue"; "name": string; "value": string }
	| { "type": StepAction | "disconnect" };

/** A rule placed in the code (RULES.md: at, a span reference), found in the text that runs: the 1-based line its
 *  statement starts on, the place, and the rule — whose `set`s are made each time that statement has run, if it
 *  matches there. */
export interface SetHook { "line": number; "place": unknown; "rule": Rule }

export interface Variable { "name": string; "value": string; "type": string; "variablesReference": number }

/** A stop, complete enough that the adapter answers stackTrace/scopes/variables with no round-trip. */
export interface Snapshot {
	"frames": { "id": number; "name": string; "line": number; "column": number; "at"?: [number, number] }[];
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
 *  rule editor) saved in my policy, deciding the call as it does. */
export type CapabilityChoice = "allow-once" | "allow-always" | "deny" | "rule";

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
	| { "type": "valueSet"; "ok": boolean; "value"?: string; "error"?: string; "snapshot"?: Snapshot };

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
 *  observed site that ran. The body of the adapter's `getCoverage` reply and of its `coverage` event. */
export interface CoverageReport { "file": string; "statements": StatementCoverage[]; "sites": SiteObservation[]; "source"?: string }

/** Worker → render surface (`PREVIEW_STREAM`); `reset` comes from the workbench bridge at session start. */
export type PreviewMessage =
	| { "type": "mutation"; "mutation": unknown }
	| { "type": "rendered" }
	| { "type": "history"; "length": number }
	| { "type": "reset" };
