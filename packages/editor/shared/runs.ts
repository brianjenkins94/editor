/**
 * Runs, as the realms that show them have them: what's running (the core runtime's registry, workbench/runs.ts, serves
 * `runs.list`; agents' `runs_list`).
 */

export type RunKind = "service" | "task";
export type RunState = "running" | "exited" | "failed" | "stopped";

/** A run, as everyone sees it. */
export interface RunInfo {
	"id": string;
	/** What was run, as typed: `node app.ts`, `npm run dev`. */
	"title": string;
	"kind": RunKind;
	"cwd": string;
	/** Where it came from: a terminal's (its number, from 1), or elsewhere. */
	"origin": { "terminal": number } | { "other": string };
	"state": RunState;
	"startedAt": number;
	"endedAt"?: number;
	"exitCode"?: number;
	/** A service's port (a dev server's preview). */
	"port"?: number;
	/** The file it runs (a dev server: its folder), and what runs it — tsval's interpreter, almostnode, the browser, or
	 *  another extension's debugger (its debug type). */
	"entry"?: string;
	"runtime"?: "tsval" | "almostnode" | "preview" | (string & {});
}
