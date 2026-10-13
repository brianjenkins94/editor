/**
 * What's running, in one place: every run the editor starts — a terminal's `node` script or `vite` dev server (and so
 * `npm run …`, which runs them) — is registered here as it starts and marked as it ends, so the editor can show what's
 * running, stop any of it, and refuse to start a second copy of a service that's already up.
 *
 * A run is a **service** (a dev server: runs until stopped) or a **task** (a script: runs to completion). The registry
 * keeps the running ones and the last few that ended, and serves them (`runs.list`) and stopping one (`runs.stop`).
 *
 * It's the core runtime's own account, read by the shell's run picker, profile-files.ts (where a profiled preview's dev
 * server serves) and agents (debug-mcp's `runs`). A run's id is the one everything about the run carries — the runner's
 * `node.start`, a debug session's launch config, a preview's production session — so what's learned from a run (its
 * coverage, its profiles, the capabilities it used) can be put together as one record. Ids are UUIDs: records outlive
 * the page. VS Code's "what's running" is the `running` extension's, from VS
 * Code's own API (terminal shell integration, debug sessions, tasks), as it would be on the desktop.
 */
import type { Hub } from "@brianjenkins94/hub";
import { serve } from "@brianjenkins94/hub";

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

/** What starts a run hands back: change it as it goes, end it once. */
export interface RunHandle {
	"id": string;
	/** A task that turns out to keep running (it started listening) becomes a service. */
	"update": (change: Partial<Pick<RunInfo, "port" | "title" | "kind" | "runtime">>) => void;
	/** It ended: by itself (`exited`, or `failed` with a nonzero code) or because it was stopped. */
	"end": (exitCode: number, stopped?: boolean) => void;
}

export interface RunRegistry {
	/** Register a run that's starting; `stop` is how to stop it (`runs.stop`). */
	"start": (run: Pick<RunInfo, "title" | "kind" | "cwd" | "origin" | "port" | "entry" | "runtime">, stop: () => void) => RunHandle;
	/** The running ones first (newest first), then the ones that ended (newest first). */
	"list": () => RunInfo[];
	/** Stop a running run; false if there's none by that id. */
	"stop": (id: string) => boolean;
	/** The running service that `matches`, if any — a second `vite` in the same directory finds the first. */
	"runningService": (matches: (run: RunInfo) => boolean) => RunInfo | undefined;
	/** Hear each run as it ends (evidence.ts records it). Returns the unsubscribe. */
	"onEnd": (listener: (run: RunInfo) => void) => () => void;
}

/** How many ended runs are kept, for the list's history. */
const KEEP_ENDED = 10;

export function createRunRegistry(hub: Hub): RunRegistry {
	const running = new Map<string, { "info": RunInfo; "stop": () => void }>();
	const ended: RunInfo[] = [];
	const endListeners = new Set<(run: RunInfo) => void>();

	// Copies: a caller in this realm gets the list itself, not a clone, and must not see a run change under it.
	const list = (): RunInfo[] => [...[...running.values()].map((run) => run.info).sort((a, b) => b.startedAt - a.startedAt), ...ended].map((info) => ({ ...info }));

	serve(hub, "runs.list", () => list());
	serve(hub, "runs.stop", (args) => {
		const { id } = (args ?? {}) as { "id"?: unknown };

		return typeof id === "string" && registry.stop(id);
	});

	const registry: RunRegistry = {
		"start": (run, stop) => {
			const id = crypto.randomUUID();
			const info: RunInfo = { ...run, "id": id, "state": "running", "startedAt": Date.now() };

			running.set(id, { "info": info, "stop": stop });

			return {
				"id": id,
				"update": (change) => {
					if (running.has(id)) {
						Object.assign(info, change);
					}
				},
				"end": (exitCode, stopped = false) => {
					if (!running.delete(id)) {
						return;
					}

					Object.assign(info, { "state": stopped ? "stopped" : exitCode === 0 ? "exited" : "failed", "endedAt": Date.now(), "exitCode": exitCode });
					ended.unshift(info);
					ended.length = Math.min(ended.length, KEEP_ENDED);

					for (const listener of endListeners) {
						try {
							listener({ ...info });
						} catch { /* a listener's failure isn't the run's */ }
					}
				}
			};
		},
		"list": list,
		"stop": (id) => {
			const run = running.get(id);

			if (run === undefined) {
				return false;
			}

			run.stop();

			return true;
		},
		"runningService": (matches) => [...running.values()].map((run) => run.info).find((info) => info.kind === "service" && matches(info)),
		"onEnd": (listener) => {
			endListeners.add(listener);

			return () => { endListeners.delete(listener); };
		}
	};

	return registry;
}
