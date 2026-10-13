/**
 * Runs, as the realms that show them have them: what's running (the core runtime's registry, workbench/runs.ts, serves
 * `runs.list`) and what there is to run (the bridge's launch.ts serves `tasks.list`) — both read by the shell's run
 * picker.
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
	 *  another extension's debugger (its debug type: `run.debugger`). */
	"entry"?: string;
	"runtime"?: "tsval" | "almostnode" | "preview" | (string & {});
}

/** One thing there is to run, as the shell's picker shows it. */
export interface LaunchTarget {
	/** Picks it back out (`tasks.run`): its source and name. */
	"id": string;
	"name": string;
	/** Its package's folder relative to the workspace ("." for the root), when it's a package's script. */
	"package"?: string;
	/** The command it runs (`npm run dev`), and where. */
	"command": string;
	"cwd": string;
	/** Keeps running until stopped (a background task: a dev server, a watcher), or runs to completion. */
	"lifecycle": "service" | "task";
}
