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
 * over the hub, `workspace.buffer`), so `node` sees exactly the files the editor, type-checker and preview see — one
 * filesystem — and every change it makes is reported back as `workspace.changed` (persisted + announced by the
 * workbench; see workspace-changes.ts). Observed over the hub: each run opens a span through
 * relayLoggerToHub, so every execution shows in the observability plane (federated up to the page's collector /
 * debug-mcp). Mirrors debug-worker.ts's hub wiring.
 */
import { getServer, Runtime } from "@brianjenkins94/almostnode";
import { createHub, createRpcClient, portTransport, serve } from "@brianjenkins94/hub";
import { installWorkerProbe, observe } from "@brianjenkins94/observability";
import pageTap from "worker-pod:page-tap";
import workerTap from "worker-pod:worker-tap";

import { NETWORK_PROBES } from "../../architecture";
import { identifyWorker } from "../../architecture-model";
import { ZENFS_NODE } from "../../architecture-zenfs";
import type { WorkspaceChange } from "../../workspace-changes";
import { WORKSPACE_CHANGED } from "../../workspace-changes";

import { installTimerKeepAlive } from "./node-keepalive";
import { attachSharedWorkspace, connectWorkspace, createZenfsVFS, getSharedWorkspaceBuffer } from "./zenfs-vfs.js";

// Own the worker's timers before any Runtime touches them, so keep-alive ref-counting sees every timer the script
// schedules (almostnode skips its own timer patch when it finds ours already installed — the `__patched` guard).
const keepAlive = installTimerKeepAlive();

// Which of the editor's two node workers this is (node-runner puts it in our URL). `servers`, the default, hosts the
// preview dev servers and answers their requests, and is never stopped; `scripts` runs the terminal's `node` scripts
// and is terminated to stop one — so stopping a script can't take a dev server, its preview, down with it.
const SCRIPTS = new URL(location.href).searchParams.get("role") === "scripts";
const hub = createHub({ "id": SCRIPTS ? "node-scripts" : "node" });
// The tab this worker belongs to (node-runner puts it in our URL), named when asking the shared service worker.
const TAB = new URL(location.href).searchParams.get("tab");

hub.link(portTransport(globalThis));
// Its logs, its uncaught errors, and its hub + own requests on $sys.arch — plus its workspace mount and the workers it
// spawns (the provoke child).
const { log, architecture } = observe(hub, { "network": NETWORK_PROBES });

installWorkerProbe(architecture, identifyWorker);

// The workspace: the shared buffer comes from the workbench over the hub, and every change this worker makes to it
// (a script's fs writes, an install) goes back as `workspace.changed` — the workbench persists and announces it.
connectWorkspace({ "architecture": architecture, "onChanges": (changes) => { hub.publish(WORKSPACE_CHANGED, changes); } });
const rpc = createRpcClient(hub);
const workspaceReady = rpc.request("workspace.buffer", undefined, { "timeoutMs": 10000, "waitForResponderMs": 10000 })
	.then(attachSharedWorkspace, (error: unknown) => { log.warn("no shared workspace — running on this worker's own filesystem", { "error": String(error) }); });

let vfsPromise: ReturnType<typeof createZenfsVFS> | undefined;
const getVfs = (): ReturnType<typeof createZenfsVFS> => (vfsPromise ??= workspaceReady.then(createZenfsVFS));

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

	// fs READ + WRITE/DELETE capability gate. almostnode's fs is synchronous, so we can't await a popup mid-run —
	// instead a BLOCKING sync-XHR to the service worker's /__capability__/decide route lets this worker wait while
	// the SW runs the async decision (the same "capability.decide" endpoint the net gate uses) and replies
	// { allow }. No SharedArrayBuffer needed. Throw (EACCES) to deny → almostnode propagates it as the fs call's
	// error. The route names this worker's tab (the SW is shared by every tab), and the SW fails closed when no
	// decider answers.
	//
	// What's at stake is the SHARED workspace, so that's what decides failure: attached, anything short of an
	// explicit allow (no SW route, a stale SW, an error page) denies. Not attached (no cross-origin isolation — so no
	// SW to ask either) this run only has its own scratch filesystem, and the network isn't gated without the SW
	// anyway, so there's nothing a denial would protect and the call goes through.
	const gateFs = (op: "read" | "write", method: string, path: string): void => {
		// Fast-path workspace READS (frequent + benign): no round-trip. Writes/deletes always gate (tamper axis),
		// and reads OUTSIDE the workspace gate (exfiltration axis — e.g. secrets on a desktop CLI's real disk).
		if (op === "read" && (path === "/workspace" || path.startsWith("/workspace/"))) {
			return;
		}

		if (getSharedWorkspaceBuffer() === undefined) {
			return;
		}

		let allow = false;

		try {
			const xhr = new XMLHttpRequest();

			xhr.open("POST", new URL("__capability__/decide" + (TAB === null ? "" : "?tab=" + TAB), location.href).href, false); // sync: blocks until the SW replies
			xhr.send(JSON.stringify({ "kind": "fs", "op": op, "method": method, "args": [path], "runId": runId })); // runId → run-grain record

			allow = xhr.status === 200 && (JSON.parse(xhr.responseText) as { "allow"?: boolean }).allow === true;
		} catch {
			// transport/parse error → fail closed (allow stays false)
		}

		if (!allow) {
			const error = new Error(`EACCES: capability denied — fs:${op} ${path}`) as Error & { "code"?: string };

			error.code = "EACCES";

			throw error;
		}
	};

	const runtime = new Runtime(vfs, {
		"cwd": cwd,
		"env": env,
		"base": base,
		"beforeFs": gateFs,
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

// Scripts are the scripts worker's alone.
if (SCRIPTS) {
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
}

// Preview bridge relay (M0): the service worker's `/__virtual__/<tab>/<port>/…` request arrives here (relayed by
// the tab's root); we drive the server listening on that port and return its response. The server is EITHER a preview dev server started in
// this worker (M1, below) OR a raw http server the running script is listening with (almostnode's port
// registry). Body crosses as a Uint8Array (structured-clone over the worker port).
interface VirtualRequest { "port": number; "method": string; "url": string; "headers": Record<string, string>; "body"?: Uint8Array; /** A worker's entry script (the service worker tells: destination worker, mode same-origin). */ "entry"?: "worker" | "sharedworker" }
interface VirtualResponse { "status": number; "statusText": string; "headers": Record<string, string>; "body": ArrayLike<number> }
interface ServerResponse { "statusCode": number; "statusMessage": string; "headers": Record<string, string>; "body": ArrayLike<number> }
type RequestHandler = { "handleRequest": (method: string, url: string, headers: Record<string, string>, body?: Uint8Array) => Promise<ServerResponse> };
type PreviewServer = RequestHandler & { "start": () => void; "setHMRTarget": (target: { "postMessage": (message: unknown, origin?: string) => void }) => void; "setTransformErrorReporter": (reporter: (info: { "url": string; "name": string; "message": string; "stack"?: string }) => void) => void; "notifyChange": (path: string) => void; "stop": () => void };

// The preview taps (page-tap.ts, worker-tap.ts — bundled to script text at build time): the dev server puts one first
// in every page it serves (inline, so it runs before the app's own code — the errors thrown during the app's module
// eval are exactly the ones we'd otherwise miss) and in every worker's entry script.
/** Where the dev server serves the worker tap as a module: under the preview's own address. */
const WORKER_TAP_PATH = "/@editor/worker-tap.js";
// (Inlined in a <script>: nothing in it may close the element early.)
// eslint-disable-next-line webawesome/no-html-in-strings -- the page tap SCRIPT injected into a preview page as text, not app chrome
const PAGE_TAP_SCRIPT = "<script>" + pageTap.replaceAll("</script", "<\\/script") + "</script>";

/** A worker's entry script (`body`, served at `url`) with the worker tap put first — on its FIRST LINE, no newline added,
 *  so the script's own lines (and its inline source map) don't move: a module worker imports it (the first import runs
 *  first; a relative path, so it stays under the preview's address), a classic one evaluates it inline. After a leading
 *  "use strict" directive, which must stay the script's first statement. */
function injectWorkerTap(body: string, url: string): string {
	const isModule = /^\s*(?:import\b|export\b)/mu.test(body);
	const depth = url.split(/[?#]/u)[0]!.split("/").length - 2;
	const tap = isModule ? `import "./${"../".repeat(Math.max(0, depth))}${WORKER_TAP_PATH.slice(1)}";` : `(0, eval)(${JSON.stringify(workerTap)});`;
	const directive = /^\s*(["'])use strict\1;?/u.exec(body)?.[0] ?? "";

	return directive + tap + body.slice(directive.length);
}

/** Inject the observability tap as the first thing inside <head> (fallback: after <html>, else prepend). */
function injectObsTap(html: string): string {
	const headMatch = /<head[^>]*>/iu.exec(html);

	if (headMatch !== null) {
		const at = headMatch.index + headMatch[0].length;

		return html.slice(0, at) + "\n" + PAGE_TAP_SCRIPT + html.slice(at);
	}

	const htmlMatch = /<html[^>]*>/iu.exec(html);

	if (htmlMatch !== null) {
		const at = htmlMatch.index + htmlMatch[0].length;

		return html.slice(0, at) + "\n" + PAGE_TAP_SCRIPT + html.slice(at);
	}

	return PAGE_TAP_SCRIPT + html;
}

// Dev servers started in this worker (M1), keyed by their virtual port — checked before the raw http registry —
// and the workspace root each serves.
const previewServers = new Map<number, PreviewServer>();
const previewRoots = new Map<number, string>();

// The last preview.start config, so preview.provoke (the debug affordance below) can cold-restart on the same
// port/root without the caller having to know them.
let lastPreviewConfig: { "port": number; "root": string } | undefined;

/** A 503 for a port nobody here listens on. */
function notListening(port: number): VirtualResponse {
	return { "status": 503, "statusText": "Service Unavailable", "headers": { "content-type": "text/plain" }, "body": new TextEncoder().encode(`No server listening on port ${port}`) };
}

/** Answer a preview's request from the server on its port in THIS worker — a dev server (the servers worker) or a
 *  script's own http.createServer (the scripts worker) — or undefined when this worker has none there. */
async function answerVirtual(raw: unknown): Promise<VirtualResponse | undefined> {
	const { port, method, url, headers, body, entry } = raw as VirtualRequest;
	const server = previewServers.get(port) ?? (getServer(port) as RequestHandler | undefined);

	// The worker tap, as a module (injectWorkerTap imports it from a worker's entry).
	if (url.split("?")[0] === WORKER_TAP_PATH) {
		return { "status": 200, "statusText": "OK", "headers": { "content-type": "text/javascript", "cache-control": "no-cache" }, "body": new TextEncoder().encode(workerTap) };
	}

	if (server === undefined) {
		return undefined;
	}

	const serverNode = (previewServers.has(port) ? "vite:" : "server:") + port;

	architecture.record(architecture.self, serverNode, "request", method + " " + url.split("?")[0], body?.byteLength ?? 0);
	const response = await server.handleRequest(method, url, headers, body);

	architecture.record(serverNode, architecture.self, response.statusCode >= 400 ? "error" : "reply", String(response.statusCode) + " " + url.split("?")[0], response.body.length);

	// HTML documents get the observability tap injected as their first script (page-tap.ts). Re-encode and fix
	// content-length; only touch text/html so assets/JS/JSON pass through untouched.
	const contentType = response.headers["content-type"] ?? response.headers["Content-Type"] ?? "";

	// A worker's entry script gets the worker tap first (worker-tap.ts) — console, errors and sockets there too.
	if (entry !== undefined && response.statusCode < 300 && /javascript|typescript/u.test(contentType)) {
		const bytes = new TextEncoder().encode(injectWorkerTap(new TextDecoder().decode(new Uint8Array(response.body)), url));
		const nextHeaders = { ...response.headers };

		delete nextHeaders["content-length"];
		delete nextHeaders["Content-Length"];
		nextHeaders["content-length"] = String(bytes.byteLength);

		return { "status": response.statusCode, "statusText": response.statusMessage, "headers": nextHeaders, "body": bytes };
	}

	if (contentType.includes("text/html")) {
		const injected = injectObsTap(new TextDecoder().decode(new Uint8Array(response.body)));
		const bytes = new TextEncoder().encode(injected);
		const nextHeaders = { ...response.headers };

		delete nextHeaders["content-length"];
		delete nextHeaders["Content-Length"];
		nextHeaders["content-length"] = String(bytes.byteLength);

		return { "status": response.statusCode, "statusText": response.statusMessage, "headers": nextHeaders, "body": bytes };
	}

	return { "status": response.statusCode, "statusText": response.statusMessage, "headers": response.headers, "body": response.body };
}

if (SCRIPTS) {
	// A script's own server, asked by the servers worker (below) for a port that isn't a dev server's.
	serve(hub, "node.script.request", async (raw): Promise<VirtualResponse> => await answerVirtual(raw) ?? notListening((raw as VirtualRequest).port));
} else {
	serve(hub, "virtual.request", async (raw): Promise<VirtualResponse> => {
		const answered = await answerVirtual(raw);

		if (answered !== undefined) {
			return answered;
		}

		// Not a dev server's port: a script's own server, in the scripts worker — or nobody's.
		return rpc.request("node.script.request", raw, { "timeoutMs": 60_000, "waitForResponderMs": 500 }).then((reply) => reply as VirtualResponse, () => notListening((raw as VirtualRequest).port));
	});
}

// M1: start almostnode's ViteDevServer in THIS worker on the shared workspace zen-fs, so the preview runs off
// the main thread and shares the editor's filesystem (no separate VFS / save mirroring). `ViteDevServer` pulls
// in `typescript` (its transpiler), so it's DYNAMICALLY imported — ts lands in a lazy chunk, off the node path.
if (!SCRIPTS) {
	serve(hub, "preview.start", async (raw): Promise<{ "ok": boolean; "port": number }> => {
		const { port, root } = raw as { "port": number; "root": string };
		const { ViteDevServer } = await import("@brianjenkins94/almostnode");
		const vfs = await getVfs();
		const server = new ViteDevServer(vfs, { "port": port, "root": root }) as unknown as PreviewServer;

		server.start();
		// HMR delivery (M2): the worker has no Window to post updates to, so give the server a stand-in whose
		// postMessage publishes the update over the hub; the main thread relays it to the preview iframe.
		server.setHMRTarget({
			"postMessage": (message) => {
				architecture.record("vite:" + port, architecture.self, "event", "hmr " + ((message as { "type"?: string } | null)?.type ?? "update"));
				hub.publish(`preview.hmr.${port}`, message);
			}
		});
		// Surface a cold-start transform failure on the observability plane so it's queryable via debug-mcp — not just a
		// worker console.warn we can't read. The server now returns a 500 (self-healing) instead of retrying, so if this
		// fires the preview may show a one-load error that recovers on reload; a recurrence means the race is still live.
		server.setTransformErrorReporter((info) => { log.warn("preview transform failed (served 500, recovers on reload)", info); });
		previewServers.set(port, server);
		previewRoots.set(port, root.replace(/\/$/u, ""));
		architecture.spawn({ "id": "vite:" + port, "label": "Vite dev server :" + port, "container": "workers", "detail": root, "dynamic": true });
		lastPreviewConfig = { "port": port, "root": root };

		return { "ok": true, "port": port };
	});
}

// Run ONE hardReset round in a freshly-spawned child worker (provoke-worker.ts): a cold module realm where
// almostnode + typescript are imported for the first time, so the FIRST transform reproduces the true cold-start
// window that a warm in-process restart can't. Its hub links into ours; we hand it the workspace SAB in one
// `provoke.round` call, await the reply, then terminate it.
async function provokeColdChild(buffer: SharedArrayBuffer, root: string, port: number, urls: string[], timeoutMs: number): Promise<{ "failures": Array<{ "url": string; "status": number }>; "transformErrors": Array<{ "url": string; "name": string; "message": string }>; "error"?: string }> {
	const worker = new Worker(new URL("./provoke-worker.js", location.href), { "type": "module" });
	const unlink = hub.link(portTransport(worker));
	// One deadline for the whole round (the child's boot + its cold transforms), and a worker that fails ends it now.
	const round = new AbortController();
	const timer = setTimeout(() => { round.abort(new Error("provoke child timed out after " + timeoutMs + "ms")); }, timeoutMs);

	worker.addEventListener("error", (event) => {
		event.preventDefault();
		round.abort(new Error(event.message || "provoke child worker error"));
	});

	try {
		architecture.record("provoke", ZENFS_NODE, "lifecycle", "mount /workspace (shared " + Math.round(buffer.byteLength / 1048576) + " MB)");

		return await rpc.request("provoke.round", { "buffer": buffer, "root": root, "port": port, "modules": urls }, { "timeoutMs": Infinity, "waitForResponderMs": timeoutMs, "signal": round.signal }) as { "failures": Array<{ "url": string; "status": number }>; "transformErrors": Array<{ "url": string; "name": string; "message": string }>; "error"?: string };
	} finally {
		clearTimeout(timer);
		unlink();
		worker.terminate();
	}
}

// Debug affordance: provoke the cold-start transform race on demand, so an agent can loop it via debug-mcp
// (provoke_transform) instead of hand-driving full-page cold boots. Two modes:
//   • default (warm): each round tears down the in-process dev server (→ a fresh, EMPTY transform cache) and fires
//     the whole src/ graph's transforms CONCURRENTLY. Fast, but the worker's typescript stays hot across rounds.
//   • hardReset: each round spawns a fresh CHILD worker (cold almostnode + ts) that does one concurrent transform
//     burst. Slower (a cold ts chunk per round) but reproduces the true first-load window. Needs the workspace SAB
//     (cross-origin isolation); without it there's nothing to hand the child, so it errors.
// A transform that loses the race returns 500 (we removed the masking retry), so we count 500s and surface the
// reporter's error shape.
interface ProvokeResult { "rounds": number; "modules": string[]; "hardReset": boolean; "provoked": boolean; "failures": Array<{ "round": number; "url": string; "status": number }>; "transformErrors": Array<{ "round": number; "url": string; "name": string; "message": string }> }
if (!SCRIPTS) {
	serve(hub, "preview.provoke", async (raw): Promise<ProvokeResult> => {
		const { rounds = 10, modules, hardReset = false, port: portArg, root: rootArg } = (raw ?? {}) as { "rounds"?: number; "modules"?: string[]; "hardReset"?: boolean; "port"?: number; "root"?: string };
		const port = portArg ?? lastPreviewConfig?.port;
		const root = rootArg ?? lastPreviewConfig?.root;

		if (port === undefined || root === undefined) {
			throw new Error("preview.provoke: no preview started yet (run the terminal `vite` command first, or pass port + root)");
		}

		const { ViteDevServer } = await import("@brianjenkins94/almostnode");
		const vfs = await getVfs();

		// The module set to hammer: caller-supplied, else the whole src/ graph (what a cold boot fetches at once).
		let urls = modules;

		if (urls === undefined) {
			try {
				const srcDir = root.replace(/\/$/, "") + "/src";

				urls = (vfs.readdirSync(srcDir) as string[]).filter((name) => /\.[jt]sx?$/.test(name)).map((name) => "/src/" + name);
			} catch {
				urls = ["/src/main.tsx", "/src/App.tsx"];
			}
		}

		const failures: ProvokeResult["failures"] = [];
		const transformErrors: ProvokeResult["transformErrors"] = [];
		const span = log.span("preview.provoke", { "rounds": rounds, "modules": urls.length, "hardReset": hardReset });

		if (hardReset) {
			const buffer = getSharedWorkspaceBuffer();

			if (buffer === undefined) {
				span.end({ "failures": 0, "error": "no shared workspace buffer" });

				throw new Error("preview.provoke hardReset: no workspace SharedArrayBuffer (needs cross-origin isolation) — use the default (warm) mode instead");
			}

			for (let round = 0; round < rounds; round += 1) {
				const outcome = await provokeColdChild(buffer, root, port, urls, 30000);

				for (const failure of outcome.failures) {
					failures.push({ "round": round, "url": failure.url, "status": failure.status });
				}

				for (const info of outcome.transformErrors) {
					transformErrors.push({ "round": round, "url": info.url, "name": info.name, "message": info.message });
				}

				if (outcome.error !== undefined) {
					log.warn("preview.provoke child error (round " + round + ")", { "error": outcome.error });
				}
			}
		} else {
			for (let round = 0; round < rounds; round += 1) {
				previewServers.get(port)?.stop();

				const server = new ViteDevServer(vfs, { "port": port, "root": root }) as unknown as PreviewServer;

				server.start();
				server.setHMRTarget({ "postMessage": (message) => { hub.publish(`preview.hmr.${port}`, message); } });
				server.setTransformErrorReporter((info) => { log.warn("preview transform failed (provoke round " + round + ")", info); transformErrors.push({ "round": round, "url": info.url, "name": info.name, "message": info.message }); });
				previewServers.set(port, server);
				lastPreviewConfig = { "port": port, "root": root };

				// Fire the whole graph at once — losing the cold-start race is the thing we're trying to catch.
				const results = await Promise.all(urls.map(async (url) => {
					const response = await server.handleRequest("GET", url, {});

					return { "url": url, "status": response.statusCode };
				}));

				for (const result of results) {
					if (result.status >= 500) {
						failures.push({ "round": round, "url": result.url, "status": result.status });
					}
				}
			}
		}

		span.end({ "failures": failures.length });
		log.info("preview.provoke done", { "rounds": rounds, "hardReset": hardReset, "failures": failures.length });

		return { "rounds": rounds, "modules": urls, "hardReset": hardReset, "provoked": failures.length > 0, "failures": failures, "transformErrors": transformErrors };
	});
}

// Hot reload: every change to the workspace — an editor save, a git checkout, a script's write, from any realm —
// arrives as `workspace.changed` (see workspace-changes.ts); each dev server re-reads the files under its root and
// emits the HMR update (notifyChange takes a root-relative path, e.g. /src/App.tsx). Like Vite's own watcher, it
// ignores .git and node_modules (and the editor's .silo): the dev server full-reloads the page for any file outside
// its module graph, and those change on nearly every save (the git index, acquired types, the capability ledger).
const UNWATCHED = /\/(?:\.git|node_modules|\.silo)(?:\/|$)/u;

if (!SCRIPTS) {
	hub.subscribe(WORKSPACE_CHANGED, (data) => {
		for (const [port, root] of previewRoots) {
			const server = previewServers.get(port);

			for (const change of data as WorkspaceChange[]) {
				if (server !== undefined && change.path.startsWith(root + "/") && !UNWATCHED.test(change.path.slice(root.length))) {
					architecture.record(architecture.self, "vite:" + port, "event", "file " + change.type);
					server.notifyChange(change.path.slice(root.length));
				}
			}
		}
	});
}

// Ctrl-C on the terminal's `vite` command: stop that port's dev server so it's really gone (a later `npm run dev`
// starts a fresh one). With no port (legacy single-preview teardown), stop every server.
if (!SCRIPTS) {
	hub.subscribe("preview.close", (data) => {
		const port = (data as { "port"?: number } | null)?.port;

		if (typeof port === "number") {
			if (previewServers.has(port)) {
				architecture.terminate("vite:" + port);
			}

			previewServers.get(port)?.stop();
			previewServers.delete(port);
			previewRoots.delete(port);

			return;
		}

		for (const [running, server] of previewServers) {
			server.stop();
			architecture.terminate("vite:" + running);
		}

		previewServers.clear();
		previewRoots.clear();
	});
}
