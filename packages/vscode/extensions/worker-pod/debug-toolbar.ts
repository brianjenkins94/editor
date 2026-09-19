/**
 * Debug-toolbar MIRROR — VS Code's debug toolbar (pause · step · restart · disconnect) is rendered by the
 * workbench INSIDE the iframe, so it can't be reparented out. This publishes the active debug session's state over
 * the hub and turns button events back into the built-in debug commands, so the preview titlebar (shell-preview.ts,
 * top frame) can host a faithful replica that drives the same actions.
 *
 *   ext host → `debug.state` { active, type, paused }   (what buttons to show + enable)
 *   shell    → `debug.command` { command }              → the matching workbench.action.debug.* command
 *
 * Paused/running is read off the DAP stream via a tracker (a `stopped` event ⇒ paused; `continued`/`terminated`, or
 * an outgoing resume request, ⇒ running). Stepping only applies to a stepping debugger (tsval); the shell decides
 * from `type` (the production/almostnode session is run-control only). All guarded so it never breaks activate().
 */
import type { Hub } from "@brianjenkins94/hub";
import * as vscode from "vscode";

/** The mirrored button → the built-in VS Code debug command it invokes (against the active session). */
const COMMANDS: Record<string, string> = {
	"continue": "workbench.action.debug.continue",
	"pause": "workbench.action.debug.pause",
	"stepOver": "workbench.action.debug.stepOver",
	"stepInto": "workbench.action.debug.stepInto",
	"stepOut": "workbench.action.debug.stepOut",
	"restart": "workbench.action.debug.restart",
	"stop": "workbench.action.debug.stop"
};

export function registerDebugToolbar(context: vscode.ExtensionContext, hub: Hub): void {
	let paused = false;

	const publish = (): void => {
		const session = vscode.debug.activeDebugSession;

		hub.publish("debug.state", { "active": session !== undefined, "type": session?.type ?? "", "paused": paused });
	};

	try {
		const debugApi = vscode.debug as Partial<typeof vscode.debug>;

		// The shell's mirrored buttons ride here → run the built-in command on the active session.
		context.subscriptions.push({ "dispose": hub.subscribe("debug.command", (data) => {
			const command = COMMANDS[(data as { "command"?: string }).command ?? ""];

			if (command !== undefined) {
				void vscode.commands.executeCommand(command);
			}
		}) });

		// Paused/running from the DAP stream — so the mirror shows pause↔continue and enables stepping only at a stop.
		if (typeof debugApi.registerDebugAdapterTrackerFactory === "function") {
			context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory("*", {
				"createDebugAdapterTracker": () => ({
					"onDidSendMessage": (message: { "type"?: string; "event"?: string }) => {
						if (message.type === "event" && message.event === "stopped") {
							paused = true;
							publish();
						} else if (message.type === "event" && (message.event === "continued" || message.event === "terminated" || message.event === "exited")) {
							paused = false;
							publish();
						}
					},
					// Some adapters don't emit `continued`; a resume request means we're about to run again.
					"onWillReceiveMessage": (message: { "command"?: string }) => {
						if (message.command === "continue" || message.command === "next" || message.command === "stepIn" || message.command === "stepOut") {
							paused = false;
							publish();
						}
					}
				})
			}));
		}

		const onSessionChange = (): void => { paused = false; publish(); };

		for (const event of [debugApi.onDidChangeActiveDebugSession, debugApi.onDidStartDebugSession, debugApi.onDidTerminateDebugSession]) {
			if (typeof event === "function") {
				context.subscriptions.push(event(onSessionChange));
			}
		}

		publish(); // initial (usually: no session)
	} catch { /* the toolbar mirror must never break activation */ }
}
