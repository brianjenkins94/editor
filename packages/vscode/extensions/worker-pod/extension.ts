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
import * as vscode from "vscode";
import { LanguageClient } from "vscode-languageclient/browser";

import { relayLoggerToHub, tapConsoleAndErrors } from "../../telemetry";
import { registerTsvalDebug } from "./debug-adapter";
import { podHub } from "./pod";

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
const controlPorts: MessagePort[] = [];
let workspaceBuffer: SharedArrayBuffer | undefined;

// Nudge the host page to load the (heavy) live preview now that OUR extension is up — activated, wired, and its
// server pod spinning. The page holds the preview import back until it hears this on the hub (main.tsx →
// rootHub.subscribe("editor.ready")), so the preview's dev server never competes with the editor's boot. We tie
// this to activation, NOT to the LSP client finishing its handshake — that can take many seconds on a cold
// start, far too late to be a useful "idle" cue. The workbench links this pod into the hub tree just AFTER
// activate() returns, so an immediate publish could beat the link (fire-and-forget, no buffering); re-announce a
// few times to clear that brief startup window. The host's handler is idempotent, and it has a timeout fallback,
// so extra beacons are harmless and a missed one only delays the preview, never loses it.
function announceEditorReady(): void {
	for (const delay of [0, 300, 1200, 3000]) {
		setTimeout(() => { podHub.publish("editor.ready"); }, delay);
	}
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
	controlPorts.push(channel.port1);

	if (workspaceBuffer !== undefined) {
		channel.port1.postMessage({ "buffer": workspaceBuffer });
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
	// The pod's own logger — its spans/records ride podHub.
	const podLog = relayLoggerToHub(podHub, "pod");

	tapConsoleAndErrors(podHub, "pod"); // raw uncaught error/rejection → the plane, beside the structured logs

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

	// The tsval debug type — a worker-backed stepping debugger (debug-adapter.ts + debug-worker.ts).
	registerTsvalDebug(context);

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
						podHub.publish(`node.exit.${runId}`, { "exitCode": 0 });
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

	// Our extension is up and its pod is spinning — tell the host page it can load the deferred live preview now.
	announceEditorReady();

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

		for (const port of controlPorts) {
			port.postMessage({ "buffer": buffer }); // → the worker's receiveSharedWorkspace → mount at /workspace
		}

		podLog.info("workspace buffer shared with LSP workers", { "workers": controlPorts.length, "mb": Math.round(buffer.byteLength / 1048576) });
	};

	return { "toWorkbench": outgoing.event, "fromWorkbench": (message: unknown) => { incoming.fire(message); }, "attachWorkspaceBuffer": attachWorkspaceBuffer };
}

export function deactivate(): Promise<void> {
	return Promise.all(clients.map((client) => client.stop())).then(() => undefined);
}
