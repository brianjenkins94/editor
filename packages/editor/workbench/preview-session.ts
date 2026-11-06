/**
 * A dev server, in Run and Debug (RUNNING.md, *The model*): as it comes up it's a session there, with Restart and Stop on the debug toolbar (a session on its own has no row in Call Stack), what it says going
 * to the Debug Console as well as its terminal. It's a window onto the service, not a way of running it: the server's the terminal's
 * (workbench/runs.ts), stopping the session stops it, and however it ends, the session does. It claims nothing a debugging session
 * would: no status bar, and Run and Debug isn't brought forward. Nothing here steps: it has no threads, and the toolbar has Restart
 * and Stop.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import type { NodeRunner } from "./node-runner";

interface Request { "seq": number; "command": string }

/** The Debug Adapter Protocol, as far as a service has it. */
function adapterOf(vscode: typeof vscodeApi, runner: NodeRunner, service: string): vscodeApi.DebugAdapter {
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
	const follow = (): void => {
		stops.push(runner.runs.follow(service, say), runner.runs.onEnd((run) => {
			if (run.id === service) {
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

	return {
		"onDidSendMessage": sent.event,
		"handleMessage": (message) => {
			const { "seq": requestSeq, command } = message as Request;

			send({ "type": "response", "request_seq": requestSeq, "command": command, "success": true, "body": bodies[command]?.() });

			if (command === "initialize") {
				event("initialized");
			}

			if (command === "launch") {
				follow();
			}
		},
		"dispose": () => {
			for (const stop of stops) {
				stop();
			}
		}
	};
}

export function installPreviewSessions(vscode: typeof vscodeApi, runner: NodeRunner, hub: Hub, log: Logger): void {
	vscode.debug.registerDebugAdapterDescriptorFactory("preview", {
		"createDebugAdapterDescriptor": (session) => new vscode.DebugAdapterInlineImplementation(adapterOf(vscode, runner, session.configuration["service"] as string))
	});

	// (a restart is ready again, in the session it has)
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
				"internalConsoleOptions": "neverOpen"
			}, { "noDebug": true, "suppressDebugStatusbar": true, "suppressDebugView": true }));
		}
	});
}
