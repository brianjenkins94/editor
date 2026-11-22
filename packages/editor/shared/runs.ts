export type RunKind = "service" | "task";
export type RunState = "running" | "exited" | "failed" | "stopped";

export interface RunInfo {
	"id": string;
	"title": string;
	"kind": RunKind;
	"cwd": string;
	"origin": { "terminal": number } | { "other": string };
	"state": RunState;
	"startedAt": number;
	"endedAt"?: number;
	"exitCode"?: number;
	"port"?: number;
	"entry"?: string;
	"runtime"?: "tsval" | "almostnode" | "preview" | (string & {});
}
