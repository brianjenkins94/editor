/**
 * Worker Pod — the manager extension (runs in the extension host, LocalProcess) that hosts a pod of workers
 * behind one extension. Today it runs NODE language servers off-thread and connects each to the editor with
 * a vscode-languageclient; a tsval-backed debug adapter is the next pod member (see debug-adapter.ts).
 *
 * Each language server worker (a server-host) runs under an almostnode runtime on a zen-fs VFS, so a
 * node-only server (cspell reading its dictionary) works in-browser. It's built + served separately
 * (lsp.config.ts → /__vscode__/lsp/, with COEP) as a normal module graph — not a blob — because almostnode
 * can't be monolithically inlined. The extension can't emit/locate those assets from its data:-URL self, so
 * it spawns them by URL relative to the workbench origin (`location.href`). (eslint moved OUT of this pod to a
 * tsserver plugin — extensions/eslint — that reuses tsserver's typescript; only cspell remains here.)
 */
import { serve } from "@brianjenkins94/hub";
import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/browser";

import { type CapabilityCall, decideCapability } from "../capabilities/decide";
import { flushRun } from "../capabilities/silo-store";
import { observe } from "@brianjenkins94/observability";
import { identifyWorker } from "../../architecture-model";
import { ZENFS_NODE } from "../../architecture-zenfs";
import { registerTsvalDebug, takeExitCode } from "./debug-adapter";
import { registerDebugToolbar } from "./debug-toolbar";
import { registerMetricsBridge } from "./metrics-bridge";
import { podHub } from "./pod";
import { registerProductionDebug } from "./production-adapter";
import { registerRunning } from "./running";

/** A run target's repo-relative identity — strips the /workspace root; "." for the root itself. */
function repoRelative(path: string): string {
	return path.replace(/^\/workspace\/?/u, "") || ".";
}

/** This extension's exports — the pod->workbench half of the hub uplink (ext host is an isolated realm, so it
 *  rides the exported API rather than a window transport). See activate + workbench-entry's bridge. */
export interface PodBridge {
	"toWorkbench": vscode.Event<unknown>;
	"fromWorkbench": (message: unknown) => void;
	/** M3b: the workbench hands over its workspace SharedArrayBuffer (zen-fs SingleBuffer). We forward it to each
	 *  LSP worker over its control port, so they mount the SAME filesystem at /workspace. SAB survives the exports
	 *  marshaling (spike-verified). No-op off cross-origin isolation (buffer is undefined). */
	"attachWorkspaceBuffer": (buffer: unknown) => void;
}

interface ServerSpec {
	"id": string;
	"name": string;
	"workerFile": string;
	"documentSelector": { "language": string }[];
}

// One worker + client per server. cspell spell-checks prose/identifiers; eslint lints JS/TS. The selectors
// MUST include the react language ids (typescriptreact/javascriptreact) — the demo opens on App.tsx, whose
// languageId is `typescriptreact`, not `typescript`; without them the client never forwards .tsx/.jsx docs to
// the server and no diagnostics ever appear.
const JS_TS_LANGUAGES = [
	{ "language": "typescript" },
	{ "language": "typescriptreact" },
	{ "language": "javascript" },
	{ "language": "javascriptreact" }
];
const SERVERS: ServerSpec[] = [
	{ "id": "cspell", "name": "cspell (almostnode)", "workerFile": "./lsp/server-host.js", "documentSelector": [...JS_TS_LANGUAGES, { "language": "plaintext" }, { "language": "markdown" }, { "language": "json" }] }
	// eslint MOVED to a TS server plugin (extensions/eslint) that runs inside tsserver and reuses tsserver's own
	// `ts` — no almostnode host, no bundled typescript copy. The old almostnode server (server-host-eslint) is
	// retired; see workbench-entry's eslint extension registration.
];

const clients: LanguageClient[] = [];
// One control port per spawned LSP worker (the workbench end of a MessageChannel), used only to hand the worker
// the shared workspace SharedArrayBuffer (M3b) — separate from the LSP JSON-RPC channel. `workspaceBuffer` is
// the SAB once the workbench provides it; a worker that spawns after gets it immediately.
const controlPorts: Array<{ "port": MessagePort; "worker": string }> = [];
let workspaceBuffer: SharedArrayBuffer | undefined;
// The pod's logger (its spans/records ride podHub), its uncaught errors, and its hub's topology/traffic — not its
// network: this extension host shares the workbench realm, whose network is probed there.
const { "log": podLog, architecture } = observe(podHub);

/** Hand a server worker the workspace buffer; it mounts it at /workspace (a worker without a reporter of its own,
 *  so the mount is put on the diagram from here). */
function shareWorkspace(control: { "port": MessagePort; "worker": string }, buffer: SharedArrayBuffer): void {
	control.port.postMessage({ "buffer": buffer }); // → the worker's receiveSharedWorkspace → mount at /workspace
	architecture.record(control.worker, ZENFS_NODE, "lifecycle", "mount /workspace (shared " + Math.round(buffer.byteLength / 1048576) + " MB)");
}

function startServer(context: vscode.ExtensionContext, spec: ServerSpec): void {
	// The workbench iframe's origin; the LocalProcess ext host shares it. The worker is served next to
	// host.html under /__vscode__/lsp/ (lsp.config.ts).
	const worker = new Worker(new URL(spec.workerFile, location.href), { "type": "module" });

	worker.addEventListener("error", (event) => {
		console.error(`[worker-pod] ${spec.id} worker error:`, event.message, "@", event.filename + ":" + event.lineno);
	});

	// Hand the worker a dedicated control port BEFORE the LSP client attaches, so the shared-workspace SAB rides
	// its own channel (never the LSP one). If the buffer's already here, send it now; else attachWorkspaceBuffer does.
	const channel = new MessageChannel();

	worker.postMessage({ "type": "ws-control" }, [channel.port2]);
	const control = { "port": channel.port1, "worker": identifyWorker(spec.workerFile)?.id ?? "worker:" + spec.id };

	controlPorts.push(control);

	if (workspaceBuffer !== undefined) {
		shareWorkspace(control, workspaceBuffer);
	}

	const client = new LanguageClient(`lsp-${spec.id}`, spec.name, worker, { "documentSelector": spec.documentSelector });

	clients.push(client);
	client.start().then(() => {
		console.log(`[worker-pod] ${spec.id} language client started`);
	}).catch((error: unknown) => {
		console.error(`[worker-pod] ${spec.id} client start failed`, error);
	});
}

export function activate(context: vscode.ExtensionContext): PodBridge {
	// The pod->root UPLINK. The ext host is an isolated `extension-file://` realm with no window path to the
	// page, so podHub can't use windowTransport. Instead it rides the extension's EXPORTED API (spike-verified:
	// ext-host EventEmitter events + functions marshal bidirectionally to the workbench): podHub links a
	// transport whose `send` fires an event the workbench receives, and whose `listen` is fed by a function the
	// workbench calls. workbench-entry links its own hub to `toWorkbench`/`fromWorkbench` and relays to the top
	// page over windowTransport. Standalone (no export consumer) → podHub is just a root; the pod still works.
	const incoming = new vscode.EventEmitter<unknown>();
	const outgoing = new vscode.EventEmitter<unknown>();

	context.subscriptions.push(incoming, outgoing, {
		"dispose": podHub.link({
			"send": (message) => { outgoing.fire(message); },
			"listen": (onMessage) => {
				const subscription = incoming.event(onMessage);

				return () => subscription.dispose();
			}
		})
	});

	// Workers link UP to podHub and announce themselves on `pod.ready`; log each join so pod membership shows
	// up in the collector (as a `[pod]` record).
	context.subscriptions.push({ "dispose": podHub.subscribe("pod.ready", (data) => { podLog.info("worker joined", data as Record<string, unknown>); }) });
	// The metrics plane's samples, for VS Code's side (the insights monitor reads them by command).
	registerMetricsBridge(context);
	// What's running, in the status bar (the run registry's list, runs.ts).
	registerRunning(context);

	// port → preview run id, so a shell-forwarded WS/WebRTC decision (keyed by the preview's port, which is all the
	// shim knows) attributes to the run that owns that port — the same port→run attribution the SW does for net.
	const previewRunByPort = new Map<number, string>();

	// ENFORCE — the single capability DECISION ENDPOINT (see ../capabilities/decide). Every thin interceptor
	// (the service-worker net gate; the WS/WebRTC preview shim; the almostnode fs/exec shim hook) full-round-trips
	// here over the hub: the SW's swHub → root → workbench → podHub reaches this serve, and the popup/grant-store/
	// redline logic all lives here (the ext host has vscode + workspace.fs), never in an interceptor. A call that
	// carries a `port` (the preview shim) but no `runId` gets its runId resolved from the port here, so the record
	// attributes to the right run. Returns true=allow, false=deny.
	context.subscriptions.push({ "dispose": serve(podHub, "capability.decide", (data) => {
		const call = data as CapabilityCall;

		if (call.runId === undefined && typeof call.port === "number") {
			call.runId = previewRunByPort.get(call.port);
		}

		return decideCapability(call);
	}) });

	// The tsval debug type — a worker-backed stepping debugger (debug-adapter.ts + debug-worker.ts).
	registerTsvalDebug(context);

	// The production debug type — presents an almostnode run (the vite preview) as a debug session with a
	// run-control controller (Stop + Debug Console). The run's driver publishes `production.launch` (federates
	// to podHub); we start its session (a launch, so VS Code's toolbar says Stop), and the adapter rides the run's
	// `production.*` channels.
	registerProductionDebug(context, podHub);

	// Mirror the active debug session's toolbar (state out, commands in) so the preview titlebar can host a replica
	// of VS Code's in-iframe debug controls. See extensions/worker-pod/debug-toolbar.ts + shell-preview.ts.
	registerDebugToolbar(context, podHub);
	context.subscriptions.push({ "dispose": podHub.subscribe("production.launch", (data) => {
		const info = data as { "id"?: string; "name"?: string; "port"?: number; "target"?: string };

		if (typeof info.id !== "string") {
			return;
		}

		const id = info.id;
		const name = info.name ?? "Production run";

		// Stamp the preview port into the session config so the debug-toolbar mirror can tell the shell WHICH preview
		// window this session drives (per-port toolbar routing). Undefined for a port-less node fallback.
		// Without debugging (noDebug): a production run can't pause or step, so VS Code greys out Pause and the steps.
		void vscode.debug.startDebugging(undefined, { "type": "production", "request": "launch", "name": name, "__prodId": id, "__port": info.port }, { "noDebug": true });

		// Run-grain bracket for the PREVIEW only (a port-bound run): the SW tags that port's gated net calls with
		// `id`, so they accumulate in silo-store's bucket; flush them as one `mode:"preview"` run record at exit. A
		// port-less production session (the node fallback) is already recorded via its node.start bracket — don't
		// double-record it here.
		if (typeof info.port !== "number") {
			return;
		}

		const port = info.port;

		previewRunByPort.set(port, id);

		const target = typeof info.target === "string" ? repoRelative(info.target) : name;
		const off = podHub.subscribe(`production.exit.${id}`, () => {
			off();
			previewRunByPort.delete(port);
			flushRun(id, { "entry": name, "mode": "preview", "exit": 0, "target": target });
		});
	}) });

	// RUN-GRAIN ledger: an almostnode run (node-worker path — the tsval-declined fallback + explicit runs, where
	// REAL fs effects happen) publishes `node.start` {runId, file} then `node.exit.<runId>` {exitCode}. The fs shim
	// threads the runId to `decide`, so silo-store accumulates the run's distinct scopes; here we flush ONE record
	// to <user>.runs.jsonl at exit. tsval runs are inert (no node.start) so they produce no record — correct, they
	// have no real effects. Guarded: a missing lifecycle event just means no record for that run, never a crash.
	// A hard Ctrl-C terminates the worker before it can publish node.exit, so node-runner publishes a synthetic
	// {exitCode:130, aborted:true} on abort — the run is still recorded (marked aborted) and its bucket released.
	context.subscriptions.push({ "dispose": podHub.subscribe("node.start", (data) => {
		const info = data as { "runId"?: string; "file"?: string };

		if (typeof info.runId !== "string") {
			return;
		}

		const runId = info.runId;
		const entry = typeof info.file === "string" ? info.file : "";
		const off = podHub.subscribe(`node.exit.${runId}`, (exitData) => {
			off();

			const info = exitData as { "exitCode"?: number; "aborted"?: boolean };

			// `node <file>` target = the entry, repo-relative — so repeated runs of the same file aggregate.
			flushRun(runId, { "entry": entry, "mode": "run", "exit": info.exitCode ?? 0, "aborted": info.aborted === true, "target": repoRelative(entry) });
		});
	}) });

	// AUTO-ATTACH: a terminal `node <file>` (node-runner's startDebug) publishes `debug.launch`; start a tsval
	// debug session for it, so running in the terminal IS a debug session (breakpoints, step-back, capability
	// stops). Relay the session's end back on the `node.exit.<runId>` channel the terminal awaits; `debug.stop`
	// (Ctrl-C) stops it. The runId rides in the launch config so start/terminate can correlate.
	//
	// Guarded end-to-end: this must NEVER break activate() (a failed worker-pod activation hangs the whole boot).
	// If any vscode.debug event API is missing here, we skip wiring AND fail `debug.launch` fast so the terminal
	// (which awaits node.exit) doesn't hang.
	try {
		const debugApi = vscode.debug as Partial<typeof vscode.debug>;
		const canTrack = typeof debugApi.onDidStartDebugSession === "function" && typeof debugApi.onDidTerminateDebugSession === "function";
		const debugSessionsByRunId = new Map<string, vscode.DebugSession>();

		if (canTrack) {
			context.subscriptions.push(
				vscode.debug.onDidStartDebugSession((session) => {
					const runId = session.configuration["__runId"] as string | undefined;

					if (typeof runId === "string") {
						debugSessionsByRunId.set(runId, session);
					}
				}),
				vscode.debug.onDidTerminateDebugSession((session) => {
					const runId = session.configuration["__runId"] as string | undefined;

					if (typeof runId === "string") {
						debugSessionsByRunId.delete(runId);
						podHub.publish(`node.exit.${runId}`, { "exitCode": takeExitCode(session.id) });
					}
				})
			);
		}

		context.subscriptions.push(
			{ "dispose": podHub.subscribe("debug.launch", (data) => {
				const info = data as { "runId": string; "file": string };

				// Can't track session end → decline, so the terminal falls back to a plain run (never breaks `node`).
				if (!canTrack) {
					podHub.publish(`debug.declined.${info.runId}`, {});

					return;
				}

				void (async () => {
					const started = await vscode.debug.startDebugging(undefined, { "type": "tsval", "request": "launch", "name": `node ${info.file}`, "program": info.file, "__runId": info.runId });

					if (started === true) {
						podHub.publish(`node.out.${info.runId}`, { "stream": "out", "data": "[debug] running in the Debug Console…\n" });
					} else {
						podHub.publish(`debug.declined.${info.runId}`, {}); // start failed → fall back to a plain run
					}
				})();
			}) },
			{ "dispose": podHub.subscribe("debug.stop", (data) => {
				const session = debugSessionsByRunId.get((data as { "runId": string }).runId);

				if (session !== undefined && typeof debugApi.stopDebugging === "function") {
					void vscode.debug.stopDebugging(session);
				}
			}) }
		);
	} catch (error) {
		podLog.error("auto-attach wiring failed", { "error": String(error) });
	}

	for (const spec of SERVERS) {
		startServer(context, spec);
	}

	context.subscriptions.push({
		"dispose": () => {
			for (const client of clients) {
				client.stop().catch(() => undefined);
			}
		}
	});

	// The pod->workbench half of the uplink, as this extension's EXPORTS: workbench-entry links its hub to
	// `toWorkbench` (ext host → workbench) and `fromWorkbench` (workbench → ext host).
	const attachWorkspaceBuffer = (buffer: unknown): void => {
		if (typeof SharedArrayBuffer === "undefined" || !(buffer instanceof SharedArrayBuffer)) {
			return; // no COI / not shared — the workers keep their local InMemory FS
		}

		workspaceBuffer = buffer;

		for (const control of controlPorts) {
			shareWorkspace(control, buffer);
		}

		podLog.info("workspace buffer shared with LSP workers", { "workers": controlPorts.length, "mb": Math.round(buffer.byteLength / 1048576) });
	};

	return { "toWorkbench": outgoing.event, "fromWorkbench": (message: unknown) => { incoming.fire(message); }, "attachWorkspaceBuffer": attachWorkspaceBuffer };
}

export function deactivate(): Promise<void> {
	return Promise.all(clients.map((client) => client.stop())).then(() => undefined);
}
