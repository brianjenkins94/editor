/**
 * Main-thread side of the terminal's node runner: manages the node-worker (extensions/worker-pod/node-worker.ts),
 * serves it the shared workspace SharedArrayBuffer (`workspace.buffer`) so it runs on the SAME zen-fs, federates its hub into the
 * workbench hub (one link carries the run lifecycle AND the worker's observability spans up to the page
 * collector), and exposes a streaming, interactive `run` the terminal's `node` command drives. See terminal-node.ts.
 *
 * Lifecycle is pub/sub keyed by a per-run id (see node-worker.ts for the subjects): we subscribe this run's
 * output + exit, publish `node.start`, stream each chunk to the terminal as it arrives, and resolve on exit —
 * with no timeout, so a long-lived server streams until it's stopped. Interactive stdin rides `node.stdin.<id>`.
 *
 * KILL: a synchronous script body blocks the worker, so an in-band "stop" can't be read — we `terminate()` the
 * worker and respawn lazily on the next run. One process runs at a time (the terminal's foreground), so a single
 * reusable worker is enough — for scripts. The preview dev servers run in a second worker (the servers worker) that's
 * never terminated, so stopping a script can't take a dev server, and its preview, down with it. A fresh scripts
 * worker announces `node.ready` once subscribed, so the first `node.start` after a (re)spawn can't out-race the
 * worker's interest and be dropped by the router.
 */
import type { Hub } from "@brianjenkins94/hub";
import { createRpcClient, portTransport, serve } from "@brianjenkins94/hub";
import type { RunRegistry } from "./runs";
import { createRunRegistry } from "./runs";

/** Streamed output from a run: `stream` is stdout ("out") or stderr ("err"). */
export type NodeOutput = (stream: "out" | "err", data: string) => void;
export interface NodeRunHooks {
	/** The run's id in the registry (runs.ts), carried by `node.start` / `debug.launch`; a fresh one if it has none. */
	"runId"?: string;
	"onOutput": NodeOutput;
	"signal"?: AbortSignal;
	/** The run started a server on `port`. */
	"onListening"?: (port: number) => void;
}

/** A response relayed back from an http server running in the worker (the preview bridge). */
export interface VirtualResponse { "status": number; "statusText": string; "headers": Record<string, string>; "body": Uint8Array }

export interface NodeRunner {
	/** What's running — every terminal's runs, in one registry (runs.ts). */
	"runs": RunRegistry;
	/** Run `file` (already resolved against cwd) to completion, streaming output; resolves with its exit code. */
	"run": (file: string, cwd: string, env: Record<string, string>, hooks: NodeRunHooks) => Promise<{ "exitCode": number }>;
	/** Auto-attach: try to launch `file` under the tsval DEBUG adapter (breakpoints, step-back, capability stops).
	 *  Resolves `{ attached: true, exitCode }` when the debug session ends, or `{ attached: false }` when the ext
	 *  host declined (debugger unavailable) — the caller should then fall back to `run` so `node <file>` never
	 *  breaks. Signals the ext host over the hub (`debug.launch`); Ctrl-C sends `debug.stop`. */
	"debug": (file: string, cwd: string, env: Record<string, string>, hooks: NodeRunHooks & { "args"?: string[] }) => Promise<{ "attached": boolean; "exitCode": number }>;
	/** Feed a chunk to the running process's stdin (no-op when nothing is running). */
	"sendStdin": (data: string) => void;
	/** Signal end-of-input (EOF) to the running process's stdin (no-op when nothing is running). */
	"endStdin": () => void;
	/** Whether a process is currently running (the terminal routes keystrokes to stdin while it is). */
	"isRunning": () => boolean;
	/** Relay a request to an http server the running process is listening with (preview bridge, M0). */
	"virtualRequest": (port: number, method: string, url: string, headers: Record<string, string>, body?: Uint8Array) => Promise<VirtualResponse>;
	/** Start a ViteDevServer in the worker on `root` of the shared workspace, reachable on `port` (preview, M1). */
	"startPreview": (port: number, root: string) => Promise<void>;
	/** Subscribe to HMR updates the worker's preview server emits; `handler` relays them to the iframe. Returns
	 *  an unsubscribe (M2). */
	"onPreviewHmr": (port: number, handler: (message: unknown) => void) => () => void;
	/** Ask the host to open the preview pane on `root` for `port` — the terminal's `vite` command fires this (M3).
	 *  `port` keys the surface so multiple concurrent previews (multi-server / multiplayer) each get their own
	 *  window; it defaults to the single-preview port when omitted. */
	"openPreview": (root: string, port?: number) => void;
	/** Stop the preview on `port`: the host closes that window and the worker stops its dev server (Ctrl-C on `vite`). */
	"closePreview": (port?: number) => void;
	/** When the preview on `port` is stopped from anywhere — Ctrl-C, or its last window closed. */
	"onPreviewClose": (port: number, handler: () => void) => () => void;
	/** Ask every preview page to report its runtime evidence now, and give the reports a moment to arrive — before a
	 *  preview's windows close, since they close before its run ends (evidence.ts folds at the end). */
	"flushPreviewEvidence": () => Promise<void>;
	/** Present a long-running production run (the vite preview) as a VS Code debug session: publishes
	 *  `production.launch` (the ext host starts a `production` attach session) and returns its id. `port`, when the
	 *  run binds one (a preview server), is carried so the SW can attribute that port's net to this run. `target`
	 *  is the runnable's stable identity (e.g. the project dir), recorded on the run-grain ledger. `id`: the run's id in
	 *  the registry, so the session is known by it (a fresh one if it has none). */
	"startProductionSession": (name: string, port?: number, target?: string, id?: string) => string;
	/** Stream a line of the run's output to the production debug session's Debug Console. */
	"emitProductionOutput": (id: string, stream: "out" | "err", data: string) => void;
	/** The debug session's Stop button (or session close) fired — the driver should tear the run down. */
	"onProductionStop": (id: string, handler: () => void) => () => void;
	/** End the production debug session (the run stopped) — terminates the session in the UI. */
	"endProductionSession": (id: string) => void;
}

/** Spawn/manage the node worker, wire it into `hub`, and return the streaming runner the terminal drives. */
/** `tab` (see main.tsx) is passed to the worker, which names it when it asks the shared service worker for a
 *  capability decision, so this tab's pod answers. */
export function createNodeRunner(hub: Hub, workspaceBuffer?: SharedArrayBuffer, tab?: string): NodeRunner {
	let worker: Worker | undefined;
	let unlink: (() => void) | undefined;
	let currentRunId: string | undefined;
	// Resolves once the freshly-spawned worker has announced it is subscribed (`node.ready`).
	let ready: Promise<void> | undefined;
	let resolveReady: (() => void) | undefined;

	hub.subscribe("node.ready", () => { resolveReady?.(); }); // kept for the runner's life (survives respawns)
	// The worker asks for the shared workspace SAB over the hub (a respawned worker asks again) and mounts the SAME
	// zen-fs at /workspace. Null without cross-origin isolation — it then runs on its own root.
	serve(hub, "workspace.buffer", () => workspaceBuffer ?? null);
	const rpc = createRpcClient(hub); // for request/reply calls into the worker (e.g. the preview bridge relay)
	// Two node workers: the scripts worker (`worker`, below) runs `node` scripts and is terminated to stop one; the
	// servers worker hosts the preview dev servers and answers their requests — started once, never terminated, so
	// stopping a script never takes a dev server (and its preview) with it.
	const workerUrl = (role: "scripts" | "servers"): URL => new URL("./lsp/node-worker.js?role=" + role + (tab === undefined ? "" : "&tab=" + tab), location.href);

	hub.link(portTransport(new Worker(workerUrl("servers"), { "type": "module" })));

	const ensureWorker = (): void => {
		if (worker !== undefined) {
			return;
		}

		// Resolve on the worker's `node.ready`, or after a fallback delay so a missed handshake never hangs a run
		// (by then the worker is certainly up and interest has propagated).
		ready = new Promise((resolve) => {
			resolveReady = resolve;
			setTimeout(resolve, 1500);
		});
		worker = new Worker(workerUrl("scripts"), { "type": "module" });

		// Federate the worker's hub into the workbench hub — run lifecycle (start/out/exit/stdin) and its spans
		// ride the one link.
		unlink = hub.link(portTransport(worker));
	};

	const killWorker = (): void => {
		worker?.terminate();
		unlink?.();
		worker = undefined;
		unlink = undefined;
		ready = undefined;
	};

	const startRun = (file: string, cwd: string, env: Record<string, string>, hooks: NodeRunHooks): Promise<{ "exitCode": number }> => new Promise((resolve) => {
		const runId = hooks.runId ?? crypto.randomUUID();

		currentRunId = runId;
		let settled = false;

		const offOutput = hub.subscribe(`node.out.${runId}`, (data) => {
			const message = data as { "stream": "out" | "err"; "data": string };

			hooks.onOutput(message.stream, message.data);
		});
		const offListening = hub.subscribe(`node.listening.${runId}`, (data) => {
			const port = (data as { "port"?: unknown } | null)?.port;

			if (typeof port === "number") {
				hooks.onListening?.(port);
			}
		});

		const finish = (exitCode: number): void => {
			if (settled) {
				return;
			}

			settled = true;
			offOutput();
			offListening();
			offExit();

			if (currentRunId === runId) {
				currentRunId = undefined;
			}

			hooks.signal?.removeEventListener("abort", onAbort);
			resolve({ "exitCode": exitCode });
		};

		const offExit = hub.subscribe(`node.exit.${runId}`, (data) => {
			finish((data as { "exitCode"?: number }).exitCode ?? 0);
		});

		// Ctrl-C: the worker may be blocked in a synchronous body, so terminate it (and drop the current run);
		// the next run lazily respawns. 130 = terminated by SIGINT. Publish the exit OURSELVES first (the killed
		// worker can't) so the run-grain ledger still records the aborted run + releases its scope bucket — this
		// reaches the pod via the uplink, which killWorker doesn't tear down, and our own offExit finishes the run.
		const onAbort = (): void => {
			hub.publish(`node.exit.${runId}`, { "exitCode": 130, "aborted": true });
			killWorker();
			finish(130);
		};

		if (hooks.signal !== undefined) {
			if (hooks.signal.aborted) {
				onAbort();

				return;
			}

			hooks.signal.addEventListener("abort", onAbort, { "once": true });
		}

		hub.publish("node.start", { "runId": runId, "file": file, "cwd": cwd, "env": env });
	});

	// Auto-attach: launch under the tsval debug adapter (ext host) instead of the node worker. We reuse the SAME
	// `node.out/exit.<runId>` channels — the adapter (or its terminate) relays onto them — so the terminal drives a
	// debug run exactly like a plain one. No node worker needed; the adapter spawns its own debug worker.
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

		const finish = (attached: boolean, exitCode: number): void => {
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
		};

		const offExit = hub.subscribe(`node.exit.${runId}`, (data) => {
			finish(true, (data as { "exitCode"?: number }).exitCode ?? 0);
		});
		// The ext host couldn't attach a debug session (debugger API unavailable / start failed) → the caller falls
		// back to a plain run, so `node <file>` keeps working.
		const offDeclined = hub.subscribe(`debug.declined.${runId}`, () => {
			finish(false, 0);
		});

		const onAbort = (): void => {
			hub.publish("debug.stop", { "runId": runId }); // ask the ext host to stop the debug session
			finish(true, 130);
		};

		if (hooks.signal !== undefined) {
			if (hooks.signal.aborted) {
				onAbort();

				return;
			}

			hooks.signal.addEventListener("abort", onAbort, { "once": true });
		}

		hub.publish("debug.launch", { "runId": runId, "file": file, "cwd": cwd, "env": env, ...hooks.args === undefined ? {} : { "args": hooks.args } });
	});

	const runs = createRunRegistry(hub);

	// A run's own server, listening: its preview opens (RUNNING.md, step 4) — the window on its port, no dev server started
	// (`server`) — and closes when the run ends.
	const serving = new Map<string, number>();

	hub.subscribe("node.listening.*", (data, envelope) => {
		const port = (data as { "port"?: unknown } | null)?.port;
		const runId = envelope.subject.slice("node.listening.".length);

		if (typeof port === "number" && !serving.has(runId)) {
			serving.set(runId, port);
			hub.publish("preview.open", { "port": port, "server": true });
		}
	});
	hub.subscribe("node.exit.*", (_data, envelope) => {
		const runId = envelope.subject.slice("node.exit.".length);
		const port = serving.get(runId);

		if (port !== undefined) {
			serving.delete(runId);
			hub.publish("preview.close", { "port": port });
		}
	});

	// A debug session VS Code starts itself (F5, Run and Debug, debug-mcp's debug_start) is a run too: the pod asks for
	// its id as the session starts, and puts it in the session's launch config. Its end is the session's (`node.exit`,
	// as for a terminal's debug run); stopping it from here stops the session (`debug.stop`).
	serve(hub, "runs.begin", (args) => {
		const { title, cwd, entry } = (args ?? {}) as { "title"?: unknown; "cwd"?: unknown; "entry"?: unknown };
		let stopped = false;
		const run = runs.start({ "title": typeof title === "string" ? title : "debug", "kind": "task", "cwd": typeof cwd === "string" ? cwd : "/workspace", "origin": { "other": "Run and Debug" }, "runtime": "tsval", ...typeof entry === "string" && entry !== "" ? { "entry": entry } : {} }, () => {
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
		"run": async (file, cwd, env, hooks) => {
			ensureWorker();
			await ready; // don't publish `node.start` until the worker has announced its subscription

			return startRun(file, cwd, env, hooks);
		},
		"debug": (file, cwd, env, hooks) => startDebug(file, cwd, env, hooks), // runs via the debug adapter (ext host), not the node worker
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
		"isRunning": () => currentRunId !== undefined,
		// The servers worker answers these (it's started above, so it only has to finish subscribing); the scripts worker
		// starts only when a script runs.
		"virtualRequest": async (port, method, url, headers, body) => rpc.request("virtual.request", { "port": port, "method": method, "url": url, "headers": headers, "body": body }, { "timeoutMs": 30000, "waitForResponderMs": 10_000 }) as Promise<VirtualResponse>,
		"startPreview": async (port, root) => {
			await rpc.request("preview.start", { "port": port, "root": root }, { "timeoutMs": 30000, "waitForResponderMs": 10_000 });
		},
		"onPreviewHmr": (port, handler) => hub.subscribe(`preview.hmr.${port}`, (message) => { handler(message); }),
		"openPreview": (root, port) => { hub.publish("preview.open", { "root": root, "port": port }); },
		"closePreview": (port) => { hub.publish("preview.close", { "port": port }); },
		"flushPreviewEvidence": async () => {
			hub.publish("evidence.flush", {});
			await new Promise((resolve) => { setTimeout(resolve, 500); });
		},
		"onPreviewClose": (port, handler) => hub.subscribe("preview.close", (data) => {
			if ((data as { "port"?: number } | null)?.port === port) {
				handler();
			}
		}),
		"startProductionSession": (name, port, target, runId) => {
			const id = runId ?? crypto.randomUUID();

			hub.publish("production.launch", { "id": id, "name": name, "port": port, "target": target });

			return id;
		},
		"emitProductionOutput": (id, stream, data) => { hub.publish(`production.out.${id}`, { "stream": stream, "data": data }); },
		"onProductionStop": (id, handler) => hub.subscribe(`production.stop.${id}`, () => { handler(); }),
		"endProductionSession": (id) => { hub.publish(`production.exit.${id}`, {}); }
	};
}
