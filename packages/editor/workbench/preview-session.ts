import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import type { NodeRunner } from "./node-runner";
import type { RecordedStops } from "./recorded-stops";
import { installRecordedStops, recordedStops } from "./recorded-stops";

interface Request { "seq": number; "command": string }

function adapterOf(vscode: typeof vscodeApi, runner: NodeRunner, hub: Hub, log: Logger, service: string): vscodeApi.DebugAdapter {
	const sent = new vscode.EventEmitter<vscodeApi.DebugProtocolMessage>();
	const stops: (() => void)[] = [];
	let seq = 0;
	const send = (message: Record<string, unknown>): void => {
		seq += 1;
		sent.fire({ ...message, "seq": seq } as vscodeApi.DebugProtocolMessage);
	};
	const event = (name: string, body?: unknown): void => {
		send({ "type": "event", "event": name, "body": body });
	};
	const say = (text: string): void => {
		event("output", { "category": "stdout", "output": text });
	};
	const run = runner.runs.list().find((each) => each.id === service);
	const recorded: RecordedStops | undefined = run?.port === undefined ? undefined : recordedStops(hub, log, run.port, event);
	const follow = (): void => {
		stops.push(runner.runs.follow(service, say), runner.runs.onEnd((ended) => {
			if (ended.id === service) {
				event("terminated");
			}
		}));
	};
	const bodies: Record<string, () => unknown> = {
		"initialize": () => ({ "supportsTerminateRequest": true, "supportsRestartRequest": true }),
		"restart": () => {
			runner.runs.restart(service);
		},
		"threads": () => ({ "threads": [] }),
		"setBreakpoints": () => ({ "breakpoints": [] }),
		"terminate": () => {
			runner.runs.stop(service);
		},
		"disconnect": () => {
			runner.runs.stop(service);
		}
	};

	return Object.assign(new vscode.Disposable(() => {
		recorded?.dispose();

		for (const stop of stops) {
			stop();
		}
	}), {
		"onDidSendMessage": sent.event,
		"handleMessage": (message: vscodeApi.DebugProtocolMessage) => {
			const { "seq": requestSeq, command } = message as Request;

			send({ "type": "response", "request_seq": requestSeq, "command": command, "success": true, "body": bodies[command]?.() });

			if (command === "initialize") {
				event("initialized");
			}

			if (command === "launch") {
				follow();
			}
		}
	});
}

export function installPreviewSessions(vscode: typeof vscodeApi, runner: NodeRunner, hub: Hub, log: Logger): void {
	installRecordedStops(vscode, hub, log);
	vscode.debug.registerDebugAdapterDescriptorFactory("preview", {
		"createDebugAdapterDescriptor": (session) => new vscode.DebugAdapterInlineImplementation(adapterOf(vscode, runner, hub, log, session.configuration["service"] as string))
	});

	const sessions = new Set<string>();

	runner.runs.onEnd((run) => {
		sessions.delete(run.id);
	});
	hub.subscribe("preview.ready", (data) => {
		const { port } = data as { "port": number };
		const service = runner.runs.runningService((run) => run.port === port);

		if (service !== undefined && !sessions.has(service.id)) {
			sessions.add(service.id);
			void log.span("editor.workbench.preview-session.start", { "port": port }, async () => vscode.debug.startDebugging(undefined, {
				"type": "preview",
				"request": "launch",
				"name": `Preview :${String(port)}`,
				"service": service.id,
				"__port": port,
				"internalConsoleOptions": "neverOpen"
			}, { "noDebug": true, "suppressDebugStatusbar": true, "suppressDebugView": true }));
		}
	});
}
