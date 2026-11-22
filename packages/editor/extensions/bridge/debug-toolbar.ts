import type { Hub } from "@brianjenkins94/hub";
import * as vscode from "vscode";

const COMMANDS: Record<string, string> = {
	"continue": "workbench.action.debug.continue",
	"pause": "workbench.action.debug.pause",
	"stepOver": "workbench.action.debug.stepOver",
	"stepInto": "workbench.action.debug.stepInto",
	"stepOut": "workbench.action.debug.stepOut",
	"restart": "workbench.action.debug.restart"
};

const RESUMES = new Set(["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue"]);

export function registerDebugToolbar(context: vscode.ExtensionContext, hub: Hub): void {
	const paused = new Set<string>();

	const publish = (): void => {
		const session = vscode.debug.activeDebugSession;
		const port = session?.configuration["__port"] as unknown;

		hub.publish("debug.state", {
			"active": session !== undefined,
			"type": session?.type ?? "",
			"paused": session !== undefined && paused.has(session.id),
			...typeof port === "number" ? { "port": port } : {}
		});
	};

	context.subscriptions.push(
		{
			"dispose": hub.subscribe("debug.command", (data) => {
				const command = COMMANDS[(data as { "command"?: string } | null)?.command ?? ""];

				if (command !== undefined) {
					void vscode.commands.executeCommand(command);
				}
			})
		},
		vscode.debug.registerDebugAdapterTrackerFactory("*", {
			"createDebugAdapterTracker": (session) => ({
				"onDidSendMessage": (message: { "type"?: string; "event"?: string }) => {
					if (message.type === "event" && message.event === "stopped") {
						paused.add(session.id);
						publish();
					} else if (message.type === "event" && (message.event === "continued" || message.event === "terminated" || message.event === "exited")) {
						paused.delete(session.id);
						publish();
					}
				},
				"onWillReceiveMessage": (message: { "command"?: string }) => {
					if (RESUMES.has(message.command ?? "") && paused.delete(session.id)) {
						publish();
					}
				}
			})
		}),
		vscode.debug.onDidChangeActiveDebugSession(publish),
		vscode.debug.onDidStartDebugSession(publish),
		vscode.debug.onDidTerminateDebugSession((session) => {
			paused.delete(session.id);
			publish();
		})
	);

	hub.subscribe("debug.state.ask", publish);
	publish();
}
