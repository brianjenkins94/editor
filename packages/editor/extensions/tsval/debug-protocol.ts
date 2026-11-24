import type { CoverageEvent, Effect, LiveBatch, LoadedPackage, Skip, TestReport, RulePlace } from "@brianjenkins94/editor-api";
import type { Replay } from "@brianjenkins94/editor-api/recorded";
import type { Policy } from "@brianjenkins94/util/silo/policy";

export type { RunEnd } from "@brianjenkins94/editor-api";

export type ToWorker =
	| { "kind": "runtime"; "port": MessagePort }
	| { "kind": "publish" }
	| { "kind": "control"; "control": Control; "trace"?: { "traceId": string; "parentSpanId": string } };

export type StepAction = "continue" | "next" | "stepIn" | "stepOut" | "stepBack" | "reverseContinue";

export interface Crash { "line": number; "at": [number, number]; "message": string; "file"?: string; "stopped"?: true }

export type Control =
	| { "type": "launch"; "source": string; "fileName": string; "lines": number[]; "control"?: SharedArrayBuffer; "policy"?: Policy; "args"?: string[]; "imports"?: string[]; "places"?: Record<string, RulePlace[]>; "live"?: boolean; "recorded"?: Record<string, unknown>; "program"?: string; "eventLoop"?: LoopStart; "files"?: Record<string, number[]>; "workspace"?: SharedArrayBuffer; "cwd"?: string; "env"?: Record<string, string>; "replay"?: Replay; "skip"?: Skip }
	| { "type": "explore"; "source": string; "fileName": string; "policy"?: Policy; "args"?: string[]; "eventLoop": LoopStart; "maxRuns"?: number; "workspace"?: SharedArrayBuffer }
	| { "type": "setBreakpoints"; "lines": number[]; "file"?: string }
	| { "type": "decide"; "deny"?: boolean; "skip"?: boolean; "policy"?: Policy; "give"?: unknown; "decided"?: "once" | "always" | "refused" }
	| { "type": "setValue"; "name": string; "value": string }
	| { "type": "pace"; "pace": "real" | "fast" }
	| { "type": "stdin"; "data": string; "end"?: boolean }
	| { "type": StepAction | "disconnect" };

export interface LoopStart { "now": number; "seed": number; "schedule"?: number[] }

export interface Printed { "text": string; "file": string; "line": number }

export interface Ordering { "output": Printed[]; "crash"?: { "message": string; "file"?: string; "line"?: number }; "schedule": number[]; "path": string[]; "runs": number }

export interface Explored { "runs": number; "complete": boolean; "outcomes": Ordering[]; "eventLoop": LoopStart }

export interface Variable { "name": string; "value": string; "type": string; "variablesReference": number }

export interface Snapshot {
	"frames": { "id": number; "name": string; "line": number; "column": number; "at"?: [number, number]; "file"?: string; "code"?: string }[];
	"scopes": Record<number, { "name": string; "variablesReference": number; "expensive": boolean }[]>;
	"variables": Record<number, Variable[]>;
	"traveled"?: boolean;
}

export interface CapabilityAsk { "line": number; "at"?: [number, number]; "capability": string; "callee": string; "resource": string; "resolved": boolean; "dangerous": boolean; "file"?: string; "source"?: string }

export type WorkerEvent =
	| { "type": "stopped"; "reason": string; "snapshot": Snapshot; "atomic"?: boolean; "ask"?: CapabilityAsk }
	| { "type": "terminated"; "exitCode"?: number; "crash"?: Crash; "quiet"?: true }
	| { "type": "recorded"; "capability": string; "resource": string; "value": unknown; "request"?: string }
	| { "type": "effects"; "effects": Effect[] }
	| { "type": "coverage"; "coverage": CoverageEvent }
	| { "type": "output"; "text": string; "stream"?: "stdout" | "stderr" | "console" }
	| { "type": "values"; "batch": LiveBatch; "file"?: string; "source"?: string }
	| { "type": "tests"; "tests": TestReport[]; "packages"?: LoadedPackage[]; "loaded"?: string[]; "skipped"?: number }
	| { "type": "valueSet"; "ok": boolean; "value"?: string; "error"?: string; "snapshot"?: Snapshot }
	| { "type": "listening"; "port": number }
	| { "type": "serving"; "ports": number[] }
	| { "type": "busy" }
	| { "type": "explored"; "explored": Explored };
