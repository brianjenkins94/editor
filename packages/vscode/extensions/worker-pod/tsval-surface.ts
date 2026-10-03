/**
 * The tsval render surface's session side: the surface (public/debug-preview.html) is a window in the shell (shell-preview.ts),
 * like an app preview; this keeps it in step with tsval debug sessions — it lives beside the tsval adapter because the
 * adapter's sessions are what it follows.
 *
 * The debug worker publishes the render stream straight to the surface on `tsval.preview.stream`. This opens the shell's
 * window when a session starts and closes it when it ends, resets the surface, keeps the session's stream to replay to
 * a surface that (re)connects (a window opened mid-session catches up), and routes the surface's DOM events and
 * time-travel requests back to the session.
 */
import type { PreviewMessage as ToPreview } from "./debug-protocol";
import * as vscode from "vscode";
import { podHub } from "./pod";

export function registerTsvalSurface(context: vscode.ExtensionContext): void {
	// Mutations since the last reset, replayed to a surface that connects mid-session.
	let buffer: ToPreview[] = [];
	let historyLength = 0;

	// One subject carries the whole render stream (reset/mutation/rendered/history); control subjects are separate.
	const emit = (message: ToPreview): void => { podHub.publish("tsval.preview.stream", message); };
	const dispose = (off: () => void): vscode.Disposable => ({ "dispose": off });

	context.subscriptions.push(
		// The worker's render stream, on its way to the surface: keep it for replay (not what we re-emit ourselves).
		dispose(podHub.subscribe("tsval.preview.stream", (data, envelope) => {
			const message = data as ToPreview;

			if (envelope.from === podHub.id) {
				return;
			}

			if (message.type === "mutation") {
				buffer.push(message);
			} else if (message.type === "history") {
				historyLength = message.length;
			}
		})),
		// A tsval session starts a fresh tree: open the shell's window, clear the buffer and the surface.
		vscode.debug.onDidStartDebugSession((session) => {
			if (session.type !== "tsval") {
				return;
			}

			buffer = [];
			historyLength = 0;
			podHub.publish("tsval.preview.open", {});
			emit({ "type": "reset" });
		}),
		// It ended: close the window.
		vscode.debug.onDidTerminateDebugSession((session) => {
			if (session.type === "tsval") {
				podHub.publish("tsval.preview.close", {});
			}
		}),
		// The surface → the session (relayed by the shell): a DOM event runs the guest's handler (it may hit a breakpoint);
		// a time-travel request rewinds.
		dispose(podHub.subscribe("tsval.preview.event", (data) => {
			const { id, event } = data as { "id": number; "event": string };

			vscode.debug.activeDebugSession?.customRequest("dispatch", { "id": id, "event": event }).then(undefined, () => undefined);
		})),
		dispose(podHub.subscribe("tsval.preview.timeTravel", (data) => {
			vscode.debug.activeDebugSession?.customRequest("timeTravel", { "index": (data as { "index": number }).index }).then(undefined, () => undefined);
		})),
		// The surface (re)connected: replay reset, the buffer and the history, so a window opened mid-session is up to date.
		dispose(podHub.subscribe("tsval.preview.hello", () => {
			emit({ "type": "reset" });

			for (const message of buffer) {
				emit(message);
			}

			if (historyLength > 0) {
				emit({ "type": "history", "length": historyLength });
			}
		}))
	);
}
