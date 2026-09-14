/**
 * Main-thread side of the terminal's node runner: manages the node-worker (extensions/worker-pod/node-worker.ts),
 * hands it the shared workspace SharedArrayBuffer so it runs on the SAME zen-fs, federates its hub into the
 * workbench hub (one link carries the run lifecycle AND the worker's observability spans up to the page
 * collector), and exposes a streaming, interactive `run` the terminal's `node` command drives. See terminal-node.ts.
 *
 * Lifecycle is pub/sub keyed by a per-run id (see node-worker.ts for the subjects): we subscribe this run's
 * output + exit, publish `node.start`, stream each chunk to the terminal as it arrives, and resolve on exit —
 * with no timeout, so a long-lived server streams until it's stopped. Interactive stdin rides `node.stdin.<id>`.
 *
 * KILL: a synchronous script body blocks the worker, so an in-band "stop" can't be read — we `terminate()` the
 * worker and respawn lazily on the next run. One process runs at a time (the terminal's foreground), so a single
 * reusable worker is enough. A fresh worker announces `node.ready` once subscribed, so the first `node.start`
 * after a (re)spawn can't out-race the worker's interest and be dropped by the router.
 */
import type { Hub } from "@brianjenkins94/hub";
import { createRpcClient, portTransport } from "@brianjenkins94/hub";

/** Streamed output from a run: `stream` is stdout ("out") or stderr ("err"). */
export type NodeOutput = (stream: "out" | "err", data: string) => void;
export interface NodeRunHooks { "onOutput": NodeOutput; "signal"?: AbortSignal }

/** A response relayed back from an http server running in the worker (the preview bridge). */
export interface VirtualResponse { "status": number; "statusText": string; "headers": Record<string, string>; "body": Uint8Array }

export interface NodeRunner {
	/** Run `file` (already resolved against cwd) to completion, streaming output; resolves with its exit code. */
	"run": (file: string, cwd: string, env: Record<string, string>, hooks: NodeRunHooks) => Promise<{ "exitCode": number }>;
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
}

/** Spawn/manage the node worker, wire it into `hub`, and return the streaming runner the terminal drives. */
export function createNodeRunner(hub: Hub, workspaceBuffer?: SharedArrayBuffer): NodeRunner {
	let worker: Worker | undefined;
	let unlink: (() => void) | undefined;
	let currentRunId: string | undefined;
	// Resolves once the freshly-spawned worker has announced it is subscribed (`node.ready`).
	let ready: Promise<void> | undefined;
	let resolveReady: (() => void) | undefined;

	hub.subscribe("node.ready", () => { resolveReady?.(); }); // kept for the runner's life (survives respawns)
	const rpc = createRpcClient(hub); // for request/reply calls into the worker (e.g. the preview bridge relay)

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
		worker = new Worker(new URL("./lsp/node-worker.js", location.href), { "type": "module" });

		// Hand the worker the shared workspace SAB over a dedicated control port (mirrors the pod), so it mounts
		// the SAME zen-fs at /workspace. Without a buffer (no cross-origin isolation) it runs on its own root.
		const channel = new MessageChannel();

		worker.postMessage({ "type": "ws-control" }, [channel.port2]);

		if (workspaceBuffer !== undefined) {
			channel.port1.postMessage({ "buffer": workspaceBuffer });
		}

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

	ensureWorker(); // warm at construction so it's subscribed well before the first command

	const startRun = (file: string, cwd: string, env: Record<string, string>, hooks: NodeRunHooks): Promise<{ "exitCode": number }> => new Promise((resolve) => {
		const runId = Math.random().toString(36).slice(2) + Date.now().toString(36);

		currentRunId = runId;
		let settled = false;

		const offOutput = hub.subscribe(`node.out.${runId}`, (data) => {
			const message = data as { "stream": "out" | "err"; "data": string };

			hooks.onOutput(message.stream, message.data);
		});

		const finish = (exitCode: number): void => {
			if (settled) {
				return;
			}

			settled = true;
			offOutput();
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
		// the next run lazily respawns. 130 = terminated by SIGINT.
		const onAbort = (): void => {
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

	return {
		"run": async (file, cwd, env, hooks) => {
			ensureWorker();
			await ready; // don't publish `node.start` until the worker has announced its subscription

			return startRun(file, cwd, env, hooks);
		},
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
		"virtualRequest": async (port, method, url, headers, body) => {
			ensureWorker();
			await ready; // the worker must be subscribed before we send it a request

			return rpc.request("virtual.request", { "port": port, "method": method, "url": url, "headers": headers, "body": body }, { "timeoutMs": 30000 }) as Promise<VirtualResponse>;
		},
		"startPreview": async (port, root) => {
			ensureWorker();
			await ready;

			await rpc.request("preview.start", { "port": port, "root": root }, { "timeoutMs": 30000 });
		}
	};
}
