/**
 * The terminal's node runner — a dedicated, pod-style worker that runs `node <file>` through almostnode's
 * Runtime, OFF the workbench main thread and inside its OWN globalThis. STREAMING + INTERACTIVE: output is
 * published live as it is produced, stdin is delivered to the running process, and the run stays alive past the
 * synchronous body until the event loop quiesces (or the main thread kills the worker).
 *
 * Why a worker at all: a heavy/long script no longer freezes the UI (it blocks THIS worker, not the page), and
 * almostnode's `globalThis.process` shim can't leak into the workbench.
 *
 * Lifecycle is pub/sub over the hub (not one-shot RPC), keyed by a per-run id so output, exit and stdin all
 * correlate — and, unlike RPC, a run has no timeout ceiling, so a long-lived server just keeps streaming until
 * it's killed:
 *   main → `node.start`         { runId, file, cwd, env }   start a run
 *   worker → `node.out.<runId>` { stream: "out"|"err", data } live output, as produced
 *   worker → `node.exit.<runId>`{ exitCode }                the run finished (event loop drained / process.exit)
 *   main → `node.stdin.<runId>` { data } | { end: true }     feed the running process's stdin
 * KILL is out-of-band: a synchronous body blocks this worker, so an in-band "stop" message can't be read — the
 * main thread calls `worker.terminate()` (see node-runner.ts) and lazily respawns.
 *
 * "Done" detection: almostnode's `runFile` is synchronous and returns when the top-level body finishes, but a
 * process is only truly done when nothing keeps its event loop alive. We ref-count keep-alive work — pending
 * timeouts, live intervals, and a stdin `data`/`readable` listener — and publish `node.exit` when it drains to
 * zero (this is what lets a one-shot script return the prompt while a server or an interactive reader stays up).
 *
 * Same almostnode-on-zen-fs pattern as server-host.ts: it runs on the SHARED workspace zen-fs (the SAB arrives
 * over a dedicated control port via receiveSharedWorkspace), so `node` sees exactly the files the editor,
 * type-checker and preview see — one filesystem. Observed over the hub: each run opens a span through
 * relayLoggerToHub, so every execution shows in the observability plane (federated up to the page's collector /
 * debug-mcp). Mirrors debug-worker.ts's hub wiring.
 */
import { getServer, Runtime } from "@brianjenkins94/almostnode";
import { createHub, portTransport, serve } from "@brianjenkins94/hub";

import { relayLoggerToHub } from "../../telemetry";

import { installTimerKeepAlive } from "./node-keepalive";
import { createZenfsVFS, receiveSharedWorkspace } from "./zenfs-vfs.js";

// Catch the shared workspace SAB from the spawner BEFORE anything runs (dedicated port; never the RPC channel).
receiveSharedWorkspace();

// Own the worker's timers before any Runtime touches them, so keep-alive ref-counting sees every timer the script
// schedules (almostnode skips its own timer patch when it finds ours already installed — the `__patched` guard).
const keepAlive = installTimerKeepAlive();

const hub = createHub({ "id": "node" });

hub.link(portTransport(globalThis));
const log = relayLoggerToHub(hub, "node");

let vfsPromise: ReturnType<typeof createZenfsVFS> | undefined;
const getVfs = (): ReturnType<typeof createZenfsVFS> => (vfsPromise ??= createZenfsVFS());

// The deploy base (this worker's served URL minus the "/__vscode__/…" tail), so a script's `file://` dynamic
// import resolves under the base-scoped service worker. Same computation as server-host.
const hereUrl = new URL(import.meta.url);
const vscodeCut = hereUrl.pathname.indexOf("/__vscode__/");
const base = hereUrl.origin + (vscodeCut === -1 ? "/" : hereUrl.pathname.slice(0, vscodeCut + 1));

/** Format a console argument the way node's console does (strings bare, everything else JSON-ish). */
function formatArg(value: unknown): string {
	if (typeof value === "string") {
		return value;
	}

	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/** A stream-shaped EventEmitter — what almostnode's `process.stdin` is (shims/process.ts). */
interface ProcessStdin {
	"emit": (event: string, ...args: unknown[]) => boolean;
	"listenerCount": (event: string) => number;
}
interface ShimProcess { "stdin"?: ProcessStdin }

interface StartArgs { "runId": string; "file": string; "cwd": string; "env": Record<string, string> }

// `process.exit(code)` in the shim emits 'exit' then THROWS `Error("Process exited with code N")` — catch that
// as a clean exit with the given code rather than a crash.
const EXIT_THROW = /^Process exited with code (\d+)$/u;

let running = false;
// The running process's stdin (the shim EventEmitter), while a run is live — fed by `node.stdin.<runId>`.
let currentStdin: ProcessStdin | undefined;

/** Run one script to completion (event-loop quiescence or process.exit), streaming output over the hub. */
async function runNode(args: StartArgs): Promise<void> {
	const { runId, file, cwd, env } = args;
	const emit = (stream: "out" | "err", data: string): void => {
		hub.publish(`node.out.${runId}`, { "stream": stream, "data": data });
	};

	const exit = (exitCode: number): void => {
		hub.publish(`node.exit.${runId}`, { "exitCode": exitCode });
	};

	if (running) {
		emit("err", "node: the runner is busy with another process\n");
		exit(1);

		return;
	}

	const vfs = await getVfs();

	if (!vfs.existsSync(file)) {
		emit("err", `node: cannot find module '${file}'\n`);
		exit(1);

		return;
	}

	running = true;
	const span = log.span("node.run", { "file": file, "cwd": cwd });
	// almostnode's module wrapper assigns globalThis.process; snapshot it and restore only when the run truly ends
	// (NOT right after the sync body — a server/interactive reader keeps running and still needs its process shim).
	const savedProcess = (globalThis as { "process"?: unknown }).process;
	let settled = false;

	const finish = (exitCode: number, failure?: string): void => {
		if (settled) {
			return;
		}

		settled = true;
		running = false;
		currentStdin = undefined;
		keepAlive.reset();
		(globalThis as { "process"?: unknown }).process = savedProcess; // restore before logging (logger writes via process)

		if (failure === undefined) {
			span.end({ "exitCode": exitCode });
		} else {
			span.error("node run failed", { "error": failure });
			span.end({ "exitCode": exitCode });
			emit("err", `${failure}\n`);
		}

		exit(exitCode);
	};

	const runtime = new Runtime(vfs, {
		"cwd": cwd,
		"env": env,
		"base": base,
		"onStdout": (data: string) => { emit("out", data); },
		"onStderr": (data: string) => { emit("err", data); },
		"onConsole": (method: string, methodArgs: unknown[]) => {
			emit(method === "error" || method === "warn" ? "err" : "out", `${methodArgs.map(formatArg).join(" ")}\n`);
		}
	});

	// The process is "alive" past its sync body while a stdin reader is attached — otherwise a script that only
	// does `process.stdin.on('data', …)` would look idle and we'd exit out from under it. Re-checked on each drain.
	const stdinIsListening = (): boolean => {
		const stdin = (globalThis as unknown as { "process"?: ShimProcess }).process?.stdin;

		return stdin !== undefined && (stdin.listenerCount("data") > 0 || stdin.listenerCount("readable") > 0);
	};

	try {
		keepAlive.begin(stdinIsListening);
		runtime.runFile(file); // synchronous — runs the top-level body; timers/promises continue after it returns
		currentStdin = (globalThis as unknown as { "process"?: ShimProcess }).process?.stdin;
		// Resolve when the event loop drains (no pending timers, no interval, no stdin reader). For a one-shot
		// script that's immediate; for a server/reader it's when it finally stops keeping itself alive.
		keepAlive.whenQuiescent(() => { finish(0); });
	} catch (error) {
		const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
		const exitMatch = EXIT_THROW.exec(error instanceof Error ? error.message : String(error));

		if (exitMatch !== null) {
			finish(Number(exitMatch[1])); // process.exit(code) — a clean, deliberate exit
		} else {
			finish(1, message);
		}
	}
}

hub.subscribe("node.start", (data) => { void runNode(data as StartArgs); });

// Tell the main thread we're subscribed so its first `node.start` doesn't out-race our interest. Repeated a few
// times because the router only forwards `node.ready` once the main side's interest in it has propagated here
// (which lands a tick or two after boot); the runner's fallback timeout covers the case where they all miss.
function announceReady(): void { hub.publish("node.ready", {}); }

announceReady();
setTimeout(announceReady, 0);
setTimeout(announceReady, 80);
setTimeout(announceReady, 250);

hub.subscribe("node.stdin.>", (data) => {
	const message = data as { "data"?: string; "end"?: boolean };

	if (currentStdin === undefined) {
		return;
	}

	if (message.end === true) {
		currentStdin.emit("end");
	} else if (message.data !== undefined) {
		currentStdin.emit("data", message.data);
	}
});

// Preview bridge relay (M0): the main thread forwards a `/__virtual__/<port>/…` request here; we drive the
// server listening on that port and return its response. The server is EITHER a preview dev server started in
// this worker (M1, below) OR a raw http server the running script is listening with (almostnode's port
// registry). Body crosses as a Uint8Array (structured-clone over the worker port).
interface VirtualRequest { "port": number; "method": string; "url": string; "headers": Record<string, string>; "body"?: Uint8Array }
interface VirtualResponse { "status": number; "statusText": string; "headers": Record<string, string>; "body": ArrayLike<number> }
interface ServerResponse { "statusCode": number; "statusMessage": string; "headers": Record<string, string>; "body": ArrayLike<number> }
type RequestHandler = { "handleRequest": (method: string, url: string, headers: Record<string, string>, body?: Uint8Array) => Promise<ServerResponse> };
type PreviewServer = RequestHandler & { "setHMRTarget": (target: { "postMessage": (message: unknown, origin?: string) => void }) => void; "notifyChange": (path: string) => void; "stop": () => void };

// Dev servers started in this worker (M1), keyed by their virtual port — checked before the raw http registry.
const previewServers = new Map<number, PreviewServer>();

serve(hub, "virtual.request", async (raw): Promise<VirtualResponse> => {
	const { port, method, url, headers, body } = raw as VirtualRequest;
	const server = previewServers.get(port) ?? (getServer(port) as RequestHandler | undefined);

	if (server === undefined) {
		return { "status": 503, "statusText": "Service Unavailable", "headers": { "content-type": "text/plain" }, "body": new TextEncoder().encode(`No server listening on port ${port}`) };
	}

	const response = await server.handleRequest(method, url, headers, body);

	return { "status": response.statusCode, "statusText": response.statusMessage, "headers": response.headers, "body": response.body };
});

// M1: start almostnode's ViteDevServer in THIS worker on the shared workspace zen-fs, so the preview runs off
// the main thread and shares the editor's filesystem (no separate VFS / save mirroring). `ViteDevServer` pulls
// in `typescript` (its transpiler), so it's DYNAMICALLY imported — ts lands in a lazy chunk, off the node path.
serve(hub, "preview.start", async (raw): Promise<{ "ok": boolean; "port": number }> => {
	const { port, root } = raw as { "port": number; "root": string };
	const { ViteDevServer } = await import("@brianjenkins94/almostnode");
	const vfs = await getVfs();
	const server = new ViteDevServer(vfs, { "port": port, "root": root }) as unknown as PreviewServer;

	server.start();
	// HMR delivery (M2): the worker has no Window to post updates to, so give the server a stand-in whose
	// postMessage publishes the update over the hub; the main thread relays it to the preview iframe.
	server.setHMRTarget({ "postMessage": (message) => { hub.publish(`preview.hmr.${port}`, message); } });
	previewServers.set(port, server);

	return { "ok": true, "port": port };
});

// M2: an editor save can't fire the worker's zen-fs watch (it's a no-op), so the main thread tells us which file
// changed; we re-read it from the shared workspace and emit the HMR update (path is root-relative, e.g. /src/App.tsx).
hub.subscribe("preview.fileChanged", (data) => {
	const { port, path } = data as { "port": number; "path": string };

	previewServers.get(port)?.notifyChange(path);
});

// Ctrl-C on the terminal's `vite` command: stop every dev server so it's really gone (a later `npm run dev`
// starts a fresh one).
hub.subscribe("preview.close", () => {
	for (const server of previewServers.values()) {
		server.stop();
	}

	previewServers.clear();
});
