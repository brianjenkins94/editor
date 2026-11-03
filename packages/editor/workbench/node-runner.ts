/**
 * Main-thread side of running programs: every run is a debug run (RUNNING.md) — `debug` launches one under the tsval
 * debug adapter (the ext host), its output, listening and exit on `node.out/listening/exit.<runId>`, its stdin
 * `node.stdin.<runId>` — and what's running, in one registry (runs.ts).
 */
import type { Hub } from "@brianjenkins94/hub";
import type { RunRegistry } from "./runs";
import { serve } from "@brianjenkins94/hub";
import { createRunRegistry } from "./runs";

/** Streamed output from a run: `stream` is stdout ("out") or stderr ("err"). */
export type NodeOutput = (stream: "out" | "err", data: string) => void;
export interface NodeRunHooks {
	/** The run's id in the registry (runs.ts), carried by `debug.launch`; a fresh one if it has none. */
	"runId"?: string;
	"onOutput": NodeOutput;
	"signal"?: AbortSignal;
	/** The run started a server on `port`. */
	"onListening"?: (port: number) => void;
	/** Run without stopping at breakpoints (VS Code's `noDebug`): an unattended run — nobody there to continue it. Its
	 *  gated calls still stop, as the policy says. */
	"noDebug"?: boolean;
}

export interface NodeRunner {
	/** What's running — every terminal's runs, in one registry (runs.ts). */
	"runs": RunRegistry;
	/** Launch `file` under the tsval DEBUG adapter (breakpoints, step-back, capability stops).
	 *  Resolves `{ attached: true, exitCode }` when the debug session ends, or `{ attached: false }` when the ext
	 *  host declined (debugger unavailable) — the caller says so and fails (no fallback). Signals the ext host over the
	 *  hub (`debug.launch`); Ctrl-C sends `debug.stop`. */
	"debug": (file: string, cwd: string, env: Record<string, string>, hooks: NodeRunHooks & { "args"?: string[] }) => Promise<{ "attached": boolean; "exitCode": number }>;
	/** Feed a chunk to the running process's stdin (no-op when nothing is running). */
	"sendStdin": (data: string) => void;
	/** Signal end-of-input (EOF) to the running process's stdin (no-op when nothing is running). */
	"endStdin": () => void;
	/** Whether a process is currently running (the terminal routes keystrokes to stdin while it is). */
	"isRunning": () => boolean;
}

/** The runner the terminal and the test runner drive, on `hub`. */
export function createNodeRunner(hub: Hub): NodeRunner {
	let currentRunId: string | undefined;

	// A run: launched under the tsval debug adapter (ext host), on `node.out/exit.<runId>` — the adapter (or its
	// terminate) relays onto them. The adapter spawns its own debug worker.
	const startDebug = (file: string, cwd: string, env: Record<string, string>, hooks: NodeRunHooks & { "args"?: string[] }): Promise<{ "attached": boolean; "exitCode": number }> => new Promise((resolve) => {
		const runId = hooks.runId ?? crypto.randomUUID();

		currentRunId = runId; // so the terminal treats it as running (routes Ctrl-C to the abort signal below)
		let settled = false;

		const offOutput = hub.subscribe(`node.out.${runId}`, (data) => {
			const message = data as { "stream": "out" | "err"; "data": string };

			hooks.onOutput(message.stream, message.data);
		});
		// It listens: a service, with its port.
		const offListening = hub.subscribe(`node.listening.${runId}`, (data) => {
			hooks.onListening?.((data as { "port": number }).port);
		});

		const offExit = hub.subscribe(`node.exit.${runId}`, (data) => {
			finish(true, (data as { "exitCode"?: number }).exitCode ?? 0);
		});
		// The ext host couldn't attach a debug session (debugger API unavailable / start failed) → the caller says so.
		const offDeclined = hub.subscribe(`debug.declined.${runId}`, () => {
			finish(false, 0);
		});

		const onAbort = (): void => {
			hub.publish("debug.stop", { "runId": runId }); // ask the ext host to stop the debug session
			finish(true, 130);
		};

		function finish(attached: boolean, exitCode: number): void {
			if (settled) {
				return;
			}

			settled = true;
			offOutput();
			offListening();
			offExit();
			offDeclined();
			if (currentRunId === runId) {
				currentRunId = undefined;
			}

			hooks.signal?.removeEventListener("abort", onAbort);
			resolve({ "attached": attached, "exitCode": exitCode });
		}

		if (hooks.signal !== undefined) {
			if (hooks.signal.aborted) {
				onAbort();

				return;
			}

			hooks.signal.addEventListener("abort", onAbort, { "once": true });
		}

		hub.publish("debug.launch", { "runId": runId, "file": file, "cwd": cwd, "env": env, ...hooks.args === undefined ? {} : { "args": hooks.args }, ...hooks.noDebug === true ? { "noDebug": true } : {} });
	});

	const runs = createRunRegistry(hub);

	// A debug session VS Code starts itself (F5, Run and Debug, debug-mcp's debug_start) is a run too — tsval's, or another
	// extension's debugger's (its debug type the run's runtime): the pod asks for its id as the session starts, and puts it in the session's launch config. Its end is the session's (`node.exit`,
	// as for a terminal's debug run); stopping it from here stops the session (`debug.stop`).
	serve(hub, "runs.begin", (args) => {
		const { title, cwd, entry, runtime } = (args ?? {}) as { "title"?: unknown; "cwd"?: unknown; "entry"?: unknown; "runtime"?: unknown };
		let stopped = false;
		const run = runs.start({ "title": typeof title === "string" ? title : "debug", "kind": "task", "cwd": typeof cwd === "string" ? cwd : "/workspace", "origin": { "other": "Run and Debug" }, "runtime": typeof runtime === "string" ? runtime : "tsval", ...typeof entry === "string" && entry !== "" ? { "entry": entry } : {} }, () => {
			stopped = true;
			hub.publish("debug.stop", { "runId": run.id });
		});
		// A server it starts listening: a service, with its port — as a script's is.
		const offListening = hub.subscribe(`node.listening.${run.id}`, (data) => {
			const port = (data as { "port"?: unknown } | null)?.port;

			if (typeof port === "number") {
				run.update({ "kind": "service", "port": port });
			}
		});
		const off = hub.subscribe(`node.exit.${run.id}`, (data) => {
			off();
			offListening();
			run.end((data as { "exitCode"?: number } | null)?.exitCode ?? 0, stopped);
		});

		return { "id": run.id };
	});

	return {
		"runs": runs,
		"debug": (file, cwd, env, hooks) => startDebug(file, cwd, env, hooks),
		"sendStdin": (data) => {
			if (currentRunId !== undefined) {
				hub.publish(`node.stdin.${currentRunId}`, { "data": data });
			}
		},
		"endStdin": () => {
			if (currentRunId !== undefined) {
				hub.publish(`node.stdin.${currentRunId}`, { "end": true });
			}
		},
		"isRunning": () => currentRunId !== undefined
	};
}
