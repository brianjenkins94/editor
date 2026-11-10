/**
 * The bridge between the editor's core runtime and VS Code (runs in the LocalProcess extension host,
 * which shares the workbench's realm): core's vscode API is this extension's, and everything of core's that VS Code
 * shows or drives crosses here — the hub's uplink, every debugger's editor-api events and capability stops, and the
 * workspace runtime it gives a debugger (tsval: extensions/tsval). Feature extensions use the public API only; this is
 * the one that touches the hub.
 */
import type { CommandTotals } from "../command-tap";
import { provideWorkspaceRuntime } from "@brianjenkins94/editor-api/runtime";
import { observe } from "@brianjenkins94/observability";
import * as vscode from "vscode";
import { storeNode } from "../../shared/architecture-zenfs";
import { ARCH_COMMANDS } from "../command-tap";
import { registerCapabilityStops } from "./capability-stops";
import { serveDebugControl } from "./debug-control";
import { registerDebugEvents } from "./debug-events";
import { registerDebugToolbar } from "./debug-toolbar";
import { bridgeHub, workspace, workspaceRuntime } from "./hub";
import { registerAnnotations } from "./annotations";
import { registerMetricsBridge } from "./metrics-bridge";
import { installPreviewGate } from "./preview-gate";
import { serveRuntimeFiles } from "./runtime-fs";

/** This extension's exports — the bridge->workbench half of the hub uplink (ext host is an isolated realm, so it
 *  rides the exported API rather than a window transport). See activate + workbench-entry's bridge. */
export interface BridgeExports {
	"toWorkbench": vscode.Event<unknown>;
	"fromWorkbench": (message: unknown) => void;
	/** The workbench hands over its workspace SharedArrayBuffer (zen-fs SingleBuffer): what a debug run's worker mounts
	 *  at /workspace (the workspace runtime's `buffer`). SAB survives the exports marshaling (spike-verified). No-op off
	 *  cross-origin isolation (buffer is undefined). */
	"attachWorkspaceBuffer": (buffer: unknown) => void;
}

// The bridge's logger (its spans/records ride bridgeHub), its uncaught errors, and its hub's topology/traffic — not its
// network: this extension host shares the workbench realm, whose network is probed there.
const { "log": bridgeLog, architecture } = observe(bridgeHub);

export function activate(context: vscode.ExtensionContext): BridgeExports {
	// The bridge->root UPLINK. The ext host is an isolated `extension-file://` realm with no window path to the
	// page, so bridgeHub can't use windowTransport. Instead it rides the extension's EXPORTED API (spike-verified:
	// ext-host EventEmitter events + functions marshal bidirectionally to the workbench): bridgeHub links a
	// transport whose `send` fires an event the workbench receives, and whose `listen` is fed by a function the
	// workbench calls. workbench-entry links its own hub to `toWorkbench`/`fromWorkbench` and relays to the top
	// page over windowTransport. Standalone (no export consumer) → bridgeHub is just a root; the bridge still works.
	const incoming = new vscode.EventEmitter<unknown>();
	const outgoing = new vscode.EventEmitter<unknown>();

	context.subscriptions.push(incoming, outgoing, {
		"dispose": bridgeHub.link({
			"send": (message) => { outgoing.fire(message); },
			"listen": (onMessage) => {
				const subscription = incoming.event(onMessage);

				return () => subscription.dispose();
			}
		})
	});

	// Workers link UP to bridgeHub and announce themselves on `bridge.ready`; log each join so bridge membership shows
	// up in the collector (as a `[bridge]` record).
	context.subscriptions.push({
		"dispose": bridgeHub.subscribe("bridge.ready", (data) => {
			bridgeLog.info("worker joined", data as Record<string, unknown>);
		})
	});

	// The workspace runtime, for any debugger in this extension host (ARCHITECTURE.md, *Extension points* 2; editor-api's
	// `workspaceRuntime()`): tsval's — an extension of its own, extensions/tsval — with the workspace's buffer, ours. Its
	// workers' file calls are answered by runtime-fs.ts, a debugger's anywhere (the web worker host's come by core's
	// bootstrap there).
	provideWorkspaceRuntime(workspaceRuntime());
	serveRuntimeFiles(context, bridgeHub);
	// The metrics plane's samples, for VS Code's side (the insights extension's status bar reads them by command).
	registerMetricsBridge(context);
	// What a change is, cosmetic or meaningful, for extensions (the cosmetic extension's badge): the workbench's BABLR.
	registerAnnotations(context);
	installPreviewGate(context, bridgeHub, bridgeLog);
	// What every debugger's runs tell core — tsval's, and another extension's (`run.debugger`: an interpreter plugged in
	// from editor-contrib) — the run contract's events, read the one way; and how each launch is resolved (debug-events.ts).
	registerDebugEvents(context);
	// Every debugger's capability stops: the question on the run, the answer back to it (capability-stops.ts).
	registerCapabilityStops(context);
	// Every debugger's sessions, driven by an agent as a person does: Run, steps, breakpoints, answers (debug-control.ts).
	serveDebugControl(context, bridgeHub, bridgeLog);
	// The active session's toolbar, in the title bar of the preview window it drives too (debug-toolbar.ts).
	registerDebugToolbar(context, bridgeHub);

	// Each extension host's command totals (extensions/command-tap.ts): the extensions, and the commands between them, on
	// the architecture view — discovered, not declared (ARCHITECTURE.md, *Discovered, not declared*). A host sends its totals; what's new
	// since its last is put on the view as that many calls.
	const seen = new Map<string, Map<string, number>>();
	const owners = new Map<string, string>();
	const spawned = new Set<string>();
	const extensionNode = (name: string, host: string): string => {
		const id = `ext:${name}`;

		if (!spawned.has(id)) {
			spawned.add(id);
			architecture.spawn({ "id": id, "label": name === "vscode" ? "VS Code" : name, "container": name === "vscode" || host.startsWith("LocalProcess") ? "workbench" : "extHostWorker", "detail": name === "vscode" ? "its own commands and its built-in extensions'" : "extension", "dynamic": true });
		}

		return id;
	};

	context.subscriptions.push(vscode.commands.registerCommand(ARCH_COMMANDS, (raw: unknown) => {
		const { host, registered, calls, files = [] } = (raw ?? {}) as Partial<CommandTotals>;

		if (typeof host !== "string" || !Array.isArray(registered) || !Array.isArray(calls)) {
			return;
		}

		for (const [command, extension] of registered) {
			owners.set(command, `${extension}\0${host}`);
			extensionNode(extension, host);
		}

		const before = seen.get(host) ?? new Map<string, number>();

		for (const [caller, command, count] of calls) {
			const key = `${caller}\0${command}`;
			const owner = owners.get(command.split(" ")[0])?.split("\0") ?? ["vscode", "LocalProcess"];
			const from = extensionNode(caller, host);
			const to = extensionNode(owner[0], owner[1]);

			for (let call = before.get(key) ?? 0; call < count; call += 1) {
				architecture.record(from, to, "request", "cmd " + command);
			}

			before.set(key, count);
		}

		// And the stores each extension read and wrote (a tool's dot-directory, by shape).
		for (const [extension, operation, shape, count] of files) {
			const key = `${extension}\0${operation}\0${shape}`;
			const from = extensionNode(extension, host);

			for (let done = before.get(key) ?? 0; done < count; done += 1) {
				architecture.record(from, storeNode(shape), "request", operation);
			}

			before.set(key, count);
		}

		seen.set(host, before);
	}));

	// AUTO-ATTACH: a terminal `node <file>` (node-runner's startDebug) — and a test file runs_tests runs, the same way —
	// publishes `debug.launch`; start a tsval debug session for it, so running in the terminal IS a debug session
	// (breakpoints, step-back, capability stops). Relay the session's end back on the `node.exit.<runId>` channel the
	// terminal awaits; `debug.stop` (Ctrl-C) stops it. The runId rides in the launch config so start/terminate can correlate.
	//
	// Guarded end-to-end: this must NEVER break activate() (a failed bridge activation hangs the whole boot).
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

					// (its run's end, with its exit code, is debug-events.ts')
					if (typeof runId === "string") {
						debugSessionsByRunId.delete(runId);
					}
				})
			);
		}

		context.subscriptions.push(
			{ "dispose": bridgeHub.subscribe("debug.launch", (data) => {
				const info = data as { "runId": string; "file": string; "args"?: string[]; "cwd"?: string; "env"?: Record<string, string>; "noDebug"?: boolean };

				// Can't track session end → decline: the terminal says the debugger couldn't take it.
				if (!canTrack) {
					bridgeHub.publish(`debug.declined.${info.runId}`, {});

					return;
				}

				void (async () => {
					// `__startedBy`: the terminal shows this run itself, and is its output and stdin (RUNNING.md, *Output goes
					// where it was started*) — with the command line's arguments, its directory and its environment. Focus stays
					// there: no Run and Debug view, no Debug Console opened (a breakpoint still stops it, and shows where).
					const started = await vscode.debug.startDebugging(undefined, { "type": "tsval", "request": "launch", "name": `node ${info.file.split("/").pop() ?? info.file}`, "program": info.file, ...info.args !== undefined && info.args.length > 0 ? { "args": info.args } : {}, ...info.cwd === undefined ? {} : { "cwd": info.cwd }, ...info.env === undefined ? {} : { "env": info.env }, "internalConsoleOptions": "neverOpen", "__runId": info.runId, "__startedBy": "terminal" }, { "suppressDebugView": true, ...info.noDebug === true ? { "noDebug": true } : {} });

					if (started !== true) {
						bridgeHub.publish(`debug.declined.${info.runId}`, {}); // start failed → the terminal says so
					}
				})();
			}) },
			{ "dispose": bridgeHub.subscribe("debug.stop", (data) => {
				const session = debugSessionsByRunId.get((data as { "runId": string }).runId);

				if (session !== undefined && typeof debugApi.stopDebugging === "function") {
					void vscode.debug.stopDebugging(session);
				}
			}) }
		);
	} catch (error) {
		bridgeLog.error("auto-attach wiring failed", { "error": String(error) });
	}

	// The bridge->workbench half of the uplink, as this extension's EXPORTS: workbench-entry links its hub to
	// `toWorkbench` (ext host → workbench) and `fromWorkbench` (workbench → ext host).
	const attachWorkspaceBuffer = (buffer: unknown): void => {
		if (typeof SharedArrayBuffer === "undefined" || !(buffer instanceof SharedArrayBuffer)) {
			return; // no COI / not shared — a debug run's worker keeps its own InMemory FS
		}

		workspace.buffer = buffer;
	};

	return {
		"toWorkbench": outgoing.event,
		"fromWorkbench": (message: unknown) => {
			incoming.fire(message);
		},
		"attachWorkspaceBuffer": attachWorkspaceBuffer
	};
}
