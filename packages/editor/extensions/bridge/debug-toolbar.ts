/**
 * The debug toolbar, in a preview window's title bar too: VS Code's (continue or pause, the steps, restart) is drawn by the
 * workbench inside its frame and can't be moved out of it, so this tells the shell what the active session is
 * (`debug.state`), and the shell (shell/preview-windows.tsx) draws its buttons in the title bar of the window it drives,
 * each of which comes back here (`debug.command`) as the built-in command, on the same session.
 *
 *   bridge → `debug.state` { active, type, paused, port }   what buttons to show, and which are enabled
 *   shell  → `debug.command` { command }                   the matching workbench.action.debug.* command
 *
 * Which window: the port a session gives (`__port`: a dev server's own session, or a recorded call of its page being
 * stepped), the one of that port's you used last. Paused or running is read off the session's DAP messages (a `stopped`
 * event is paused; `continued`, `terminated` or a resume request going in is running).
 */
import type { Hub } from "@brianjenkins94/hub";
import * as vscode from "vscode";

/** Each of the mirrored buttons, and the built-in debug command it runs on the active session. */
const COMMANDS: Record<string, string> = {
	"continue": "workbench.action.debug.continue",
	"pause": "workbench.action.debug.pause",
	"stepOver": "workbench.action.debug.stepOver",
	"stepInto": "workbench.action.debug.stepInto",
	"stepOut": "workbench.action.debug.stepOut",
	"restart": "workbench.action.debug.restart"
};

/** DAP requests that set a stopped session going again. */
const RESUMES = new Set(["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue"]);

export function registerDebugToolbar(context: vscode.ExtensionContext, hub: Hub): void {
	/** Which sessions are stopped now, by id. */
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
				// (some adapters tell no `continued`: a resume going in means it's about to run)
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

	// (asked once the shell's there: it may come after the bridge)
	hub.subscribe("debug.state.ask", publish);
	publish();
}
