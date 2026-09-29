/**
 * The tsval debugger's adapter ⇄ worker protocol, over the pod hub. Each session has two subjects: control goes DOWN
 * (`debug.session.<id>.control`, adapter → worker) and events come UP (`debug.session.<id>.event`, worker → adapter),
 * so several sessions share the pod hub without crossing. A control message that starts work carries the adapter
 * action's trace context in the hub envelope, so the worker's step continues that trace. The React render stream goes
 * straight to the render surface on `tsval.preview.stream` (see debug-preview-view.ts), not through the adapter.
 *
 * The one thing that isn't a message: resuming from a breakpoint inside a host-invoked guest call (a React handler).
 * The worker is blocked in Atomics.wait there, so the adapter resumes it through the shared control word it sent at
 * launch.
 */
import type { Policy } from "@brianjenkins94/util/silo/policy";

export const controlSubject = (session: string): string => "debug.session." + session + ".control";
export const eventSubject = (session: string): string => "debug.session." + session + ".event";
/** The render surface's stream (mutations, rendered, history, reset). */
export const PREVIEW_STREAM = "tsval.preview.stream";

export type StepAction = "continue" | "next" | "stepIn" | "stepOut" | "stepBack" | "reverseContinue";

/** Adapter → worker. */
export type Control =
	| { "type": "launch"; "source": string; "fileName": string; "lines": number[]; "control"?: SharedArrayBuffer; "react"?: boolean; "policy"?: Policy }
	| { "type": "setBreakpoints"; "lines": number[] }
	| { "type": "dispatch"; "id": number; "event": string }
	| { "type": "timeTravel"; "index": number }
	| { "type": StepAction | "disconnect" };

export interface Variable { "name": string; "value": string; "type": string; "variablesReference": number }

/** A stop, complete enough that the adapter answers stackTrace/scopes/variables with no round-trip. */
export interface Snapshot {
	"frames": { "id": number; "name": string; "line": number; "column": number }[];
	"scopes": Record<number, { "name": string; "variablesReference": number; "expensive": boolean }[]>;
	"variables": Record<number, Variable[]>;
	/** True when this stop is an earlier point in history (a time-travel view), for the stop reason. */
	"traveled"?: boolean;
}

/** Worker → adapter. */
export type WorkerEvent =
	| { "type": "stopped"; "reason": string; "snapshot": Snapshot; "atomic"?: boolean }
	| { "type": "terminated" }
	| { "type": "output"; "text": string }
	| { "type": "rendered" }
	| { "type": "history"; "length": number };

/** Worker → render surface (`PREVIEW_STREAM`); `reset` comes from the workbench bridge at session start. */
export type PreviewMessage =
	| { "type": "mutation"; "mutation": unknown }
	| { "type": "rendered" }
	| { "type": "history"; "length": number }
	| { "type": "reset" };
