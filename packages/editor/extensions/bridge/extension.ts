/**
 * The bridge between the editor's core runtime and VS Code (runs in the LocalProcess extension host,
 * which shares the workbench's realm): core's vscode API is this extension's, and everything of core's that VS Code
 * shows or drives crosses here — the hub's uplink, every debugger's editor-api events and capability stops, the
 * workspace runtime it gives a debugger (tsval: extensions/tsval), tasks, Source Control, the run picker. Feature
 * extensions use the public API only; this is the one that touches the hub.
 */
import type { CommandTotals } from "../command-tap";
import type { CapabilityCall } from "./capabilities/decide";
import { takeEffects } from "@brianjenkins94/editor-api/effects";
import { recordedResult, recordResult } from "@brianjenkins94/editor-api/policy";

import { provideWorkspaceRuntime } from "@brianjenkins94/editor-api/runtime";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { observe } from "@brianjenkins94/observability";
import * as vscode from "vscode";
import { storeNode } from "../../shared/architecture-zenfs";
import { ARCH_COMMANDS } from "../command-tap";
import { serveAnswers } from "./answers";
import { decideCapability } from "./capabilities/decide";
import { registerCapabilityStops } from "./capability-stops";
import { runProgram, serveDebugControl } from "./debug-control";
import { registerDebugEvents } from "./debug-events";
import { registerDebugToolbar } from "./debug-toolbar";
import { bridgeHub, workspace, workspaceRuntime } from "./hub";
import { registerLaunch } from "./launch";
import { registerMetricsBridge } from "./metrics-bridge";
import { registerParseStatus } from "./parse-status";
import { registerProductionDebug } from "./production-adapter";
import { registerRecordedStops } from "./recorded-stops";
import { registerReplay } from "./replay";
import { serveRuntimeFiles } from "./runtime-fs";
import { registerTasks } from "./tasks";

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
	const rpc = createRpcClient(bridgeHub);

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
	// The metrics plane's samples, for VS Code's side (the insights monitor reads them by command).
	registerMetricsBridge(context);
	registerParseStatus(context);

	// port → preview run id, so a shell-forwarded WS/WebRTC decision (keyed by the preview's port, which is all the
	// shim knows) attributes to the run that owns that port — the same port→run attribution the SW does for net.
	const previewRunByPort = new Map<number, string>();

	// ENFORCE — the single capability DECISION ENDPOINT (see ../capabilities/decide). Every thin interceptor
	// (the service-worker net gate; the WS/WebRTC preview shim; the almostnode fs/exec shim hook) full-round-trips
	// here over the hub: the SW's swHub → root → workbench → bridgeHub reaches this serve, and the popup/grant-store/
	// redline logic all lives here (the ext host has vscode + workspace.fs), never in an interceptor. A call that
	// carries a `port` (the preview shim) but no `runId` gets its runId resolved from the port here, so the record
	// attributes to the right run. Returns true=allow, false=deny.
	context.subscriptions.push({ "dispose": serve(bridgeHub, "capability.decide", (data) => {
		const call = data as CapabilityCall;

		if (call.runId === undefined && typeof call.port === "number") {
			call.runId = previewRunByPort.get(call.port);
		}

		return decideCapability(call);
	}) });

	// What a call returned when it ran for real — a preview's fetch, recorded by the service worker's net gate — kept so
	// a rule can give it back in the debugger instead of the call (RUNNING.md, *A call's result*); and asked for by the
	// margin's Rule… at a capability stop, to prefill it.
	context.subscriptions.push({ "dispose": serve(bridgeHub, "capability.record", async (data) => {
		const { capability, resource, value } = (data ?? {}) as { "capability"?: unknown; "resource"?: unknown; "value"?: unknown };

		if (typeof capability === "string" && typeof resource === "string") {
			await recordResult(capability, resource, value);
		}

		return null;
	}) }, { "dispose": serve(bridgeHub, "capability.recorded", async (data) => {
		const { capability, resource } = (data ?? {}) as { "capability"?: unknown; "resource"?: unknown };

		return typeof capability === "string" && typeof resource === "string" ? await recordedResult(capability, resource) ?? null : null;
	}) });

	// The workspace runtime, for any debugger in this extension host (ARCHITECTURE.md, *Extension points* 2; editor-api's
	// `workspaceRuntime()`): tsval's — an extension of its own, extensions/tsval — with the workspace's buffer, ours. Its
	// workers' file calls are answered by runtime-fs.ts, a debugger's anywhere (the web worker host's come by core's
	// bootstrap there).
	provideWorkspaceRuntime(workspaceRuntime());
	serveRuntimeFiles(context, bridgeHub, bridgeLog);
	// What every debugger's runs tell core — tsval's, and another extension's (`run.debugger`: an interpreter plugged in
	// from editor-contrib) — the run contract's events, read the one way; and what Run means for each (debug-events.ts).
	registerDebugEvents(context);
	// Every debugger's capability stops: the question in the margin, the answer back to the run (capability-stops.ts).
	registerCapabilityStops(context, bridgeHub);
	// Every debugger's sessions driven over the hub (debug-mcp's debug_* tools): followed and stepped through DAP.
	serveDebugControl(context, bridgeHub, bridgeLog);
	// What agents ask of the editor's extensions, each by its command (answers.ts: a fixed list).
	serveAnswers(context, bridgeHub);
	// What there is to run, as tasks run by core's shell (tasks.ts); and the shell's run picker, from them (launch.ts).
	registerTasks(context);
	registerLaunch(context);
	// A recorded stop's call, stepped in the debugger (replay.ts).
	registerReplay(context);
	// The editor's ▷: Run (RUNNING.md) — the file, as every way in runs it.
	// (`cases`: each a run's arguments, one run after another — the Margin's Mock… of process.argv)
	context.subscriptions.push(vscode.commands.registerCommand("editor.debugFile", (uri?: vscode.Uri, options?: { "cases"?: string[][] }) => {
		void runProgram({ ...uri instanceof vscode.Uri ? { "program": uri.path } : {}, ...Array.isArray(options?.cases) ? { "cases": options.cases } : {} }).catch(() => undefined);
	}));
	// Durable annotations on code spans (RUNTIME-EVIDENCE.md, *Durable annotations on spans*), from core's BABLR (bablr.ts: one worker, its parses cached
	// by content, so an unchanged file is never parsed twice) — for extensions, everything they attach to code: notes,
	// the insights extension's evidence, the event sheet's anchors. Commands: what an extension can call, through
	// editor-api's annotations(). Each answers `{ value }`, or `{ unparsable }` — why BABLR's grammar doesn't take the
	// text as it is (a file mid-edit, often), which loses nothing: what's placed stays where it was. A failure rejects.
	const annotation = async (topic: string, args: Record<string, unknown>): Promise<{ "value": unknown } | { "unparsable": string }> => rpc.request(`annotations.${topic}`, args, { "timeoutMs": 120_000, "waitForResponderMs": 30_000 }) as Promise<{ "value": unknown } | { "unparsable": string }>;

	context.subscriptions.push(
		// The spans of a text an annotation can attach to — each one's id (its BABLR Merkle hash) and offsets, from the
		// text's cached parse; punctuation left out…
		vscode.commands.registerCommand("editor.annotations.spans", async (source: unknown) => annotation("spans", { "source": source })),
		// …a reference to the span standing for each range of a text — what an annotation keeps (undefined where no span
		// stands for it)…
		vscode.commands.registerCommand("editor.annotations.refer", async (source: unknown, file: unknown, ranges: unknown) => {
			const answer = await annotation("refer", { "source": source, "file": file, "ranges": ranges });

			return "value" in answer && Array.isArray(answer.value) ? { "value": answer.value.map((ref: unknown) => ref ?? undefined) } : answer;
		}),
		// …and where each reference's span is now: attached, moved, re-placed, uncertain or orphaned, with where it
		// landed. `observed` (runtime evidence): by its id alone — one that's lost fades, it isn't looked for. `types`:
		// what spans of the text are beyond their shape (by span id: TypeScript's type, observed tags), for the typed
		// strategy. `texts`: texts the file went through that the caller knows (its edit history's), each a baseline a
		// reference made against it is followed from by the structural diff, as one made against a commit is.
		// …and what a change from one text to another is: cosmetic or semantic, the nodes that changed and their lines
		// (core's classifier, sharing the worker's cached parses — the cosmetic extension's badge).
		vscode.commands.registerCommand("editor.annotations.classify", async (before: unknown, after: unknown) => annotation("classify", { "before": before, "after": after })),
		vscode.commands.registerCommand("editor.annotations.resolve", async (source: unknown, file: unknown, refs: unknown, options?: { "observed"?: boolean; "types"?: unknown; "texts"?: string[] }) => annotation("resolve", { "source": source, "file": file, "refs": refs, "observed": options?.observed === true, "types": options?.types, "texts": options?.texts ?? [] }))
	);

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

	// The production debug type — presents an almostnode run (the vite preview) as a debug session with a
	// run-control controller (Stop + Debug Console). The run's driver publishes `production.launch` (federates
	// to bridgeHub); we start its session (a launch, so VS Code's toolbar says Stop), and the adapter rides the run's
	// `production.*` channels.
	registerProductionDebug(context, bridgeHub);
	// A breakpoint in a page's code: a recorded stop, told as its preview's run's values (recorded-stops.ts).
	registerRecordedStops(context, bridgeHub);

	// Mirror the active debug session's toolbar (state out, commands in) so the preview titlebar can host a replica
	// of VS Code's in-iframe debug controls. See extensions/bridge/debug-toolbar.ts + shell-preview.ts.
	registerDebugToolbar(context, bridgeHub);
	context.subscriptions.push({ "dispose": bridgeHub.subscribe("production.launch", (data) => {
		const info = data as { "id"?: string; "name"?: string; "port"?: number; "target"?: string };

		if (typeof info.id !== "string") {
			return;
		}

		const { id } = info;
		const name = info.name ?? "Production run";

		// Stamp the preview port into the session config so the debug-toolbar mirror can tell the shell WHICH preview
		// window this session drives (per-port toolbar routing).
		// Without debugging (noDebug): a production run can't pause or step, so VS Code greys out Pause and the steps.
		void vscode.debug.startDebugging(undefined, { "type": "production", "request": "launch", "name": name, "__prodId": id, "__port": info.port }, { "noDebug": true });

		// A preview's run (a port-bound one): the SW tags that port's gated net calls with `id`, so they're counted among
		// its effects (editor-api/effects's recordEffect), which its envelope takes when it ends (`run.effects`).
		if (typeof info.port !== "number") {
			return;
		}

		const { port } = info;

		previewRunByPort.set(port, id);

		const off = bridgeHub.subscribe(`production.exit.${id}`, () => {
			off();
			previewRunByPort.delete(port);
		});
	}) });

	// A run's effects, as its envelope is written (evidence.ts): what it made, was denied, skipped or was given — and gone
	// from here once taken.
	context.subscriptions.push({ "dispose": serve(bridgeHub, "run.effects", (data) => {
		const { id } = (data ?? {}) as { "id"?: unknown };

		return typeof id === "string" ? takeEffects(id) : [];
	}) });

	// AUTO-ATTACH: a terminal `node <file>` (node-runner's startDebug) publishes `debug.launch`; start a tsval
	// debug session for it, so running in the terminal IS a debug session (breakpoints, step-back, capability
	// stops). Relay the session's end back on the `node.exit.<runId>` channel the terminal awaits; `debug.stop`
	// (Ctrl-C) stops it. The runId rides in the launch config so start/terminate can correlate.
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
				const info = data as { "runId": string; "file": string; "args"?: string[]; "cwd"?: string; "env"?: Record<string, string> };

				// Can't track session end → decline: the terminal says the debugger couldn't take it.
				if (!canTrack) {
					bridgeHub.publish(`debug.declined.${info.runId}`, {});

					return;
				}

				void (async () => {
					// `__startedBy`: the terminal shows this run itself (the running extension leaves the session out), and is its
					// output and stdin (RUNNING.md, *Output goes where it was started*) — with the command line's arguments (none: a
					// rule's, the margin's Mock), its directory and its environment. Focus stays there: no Run and Debug view, no
					// Debug Console opened (a breakpoint still stops it, and shows where).
					const started = await vscode.debug.startDebugging(undefined, { "type": "tsval", "request": "launch", "name": `node ${info.file.split("/").pop() ?? info.file}`, "program": info.file, ...info.args !== undefined && info.args.length > 0 ? { "args": info.args } : {}, ...info.cwd === undefined ? {} : { "cwd": info.cwd }, ...info.env === undefined ? {} : { "env": info.env }, "internalConsoleOptions": "neverOpen", "__runId": info.runId, "__startedBy": "terminal" }, { "suppressDebugView": true });

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
