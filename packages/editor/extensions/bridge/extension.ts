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
import { registerLogChannel } from "./log-channel";
import { registerMessageChannel } from "./message-channel";
import { registerMetricsBridge } from "./metrics-bridge";
import { installPreviewGate } from "./preview-gate";
import { serveRuntimeFiles } from "./runtime-fs";

export interface BridgeExports {
	"toWorkbench": vscode.Event<unknown>;
	"fromWorkbench": (message: unknown) => void;
	"attachWorkspaceBuffer": (buffer: unknown) => void;
}

const { "log": bridgeLog, architecture } = observe(bridgeHub);

export function activate(context: vscode.ExtensionContext): BridgeExports {
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

	context.subscriptions.push({
		"dispose": bridgeHub.subscribe("bridge.ready", (data) => {
			bridgeLog.info("worker joined", data as Record<string, unknown>);
		})
	});

	provideWorkspaceRuntime(workspaceRuntime());
	serveRuntimeFiles(context, bridgeHub);
	registerMetricsBridge(context);
	registerLogChannel(context);
	registerMessageChannel(context);
	registerAnnotations(context);
	installPreviewGate(context, bridgeHub, bridgeLog);
	registerDebugEvents(context);
	registerCapabilityStops(context);
	serveDebugControl(context, bridgeHub, bridgeLog);
	registerDebugToolbar(context, bridgeHub);

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
					}
				})
			);
		}

		context.subscriptions.push(
			{ "dispose": bridgeHub.subscribe("debug.launch", (data) => {
				const info = data as { "runId": string; "file": string; "args"?: string[]; "runtimeArgs"?: string[]; "cwd"?: string; "env"?: Record<string, string>; "noDebug"?: boolean; "skip"?: unknown };

				if (!canTrack) {
					bridgeHub.publish(`debug.declined.${info.runId}`, {});

					return;
				}

				void (async () => {
					const started = await vscode.debug.startDebugging(undefined, { "type": "tsval", "request": "launch", "name": `node ${info.file.split("/").pop() ?? info.file}`, "program": info.file, ...info.args !== undefined && info.args.length > 0 ? { "args": info.args } : {}, ...info.runtimeArgs === undefined ? {} : { "runtimeArgs": info.runtimeArgs }, ...info.cwd === undefined ? {} : { "cwd": info.cwd }, ...info.env === undefined ? {} : { "env": info.env }, "internalConsoleOptions": "neverOpen", "__runId": info.runId, "__startedBy": "terminal", ...info.skip === undefined ? {} : { "__skip": info.skip } }, { "suppressDebugView": true, ...info.noDebug === true ? { "noDebug": true } : {} });

					if (started !== true) {
						bridgeHub.publish(`debug.declined.${info.runId}`, {});
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

	const attachWorkspaceBuffer = (buffer: unknown): void => {
		if (typeof SharedArrayBuffer === "undefined" || !(buffer instanceof SharedArrayBuffer)) {
			return;
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
