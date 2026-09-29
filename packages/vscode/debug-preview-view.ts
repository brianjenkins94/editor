/**
 * tsval debug preview — workbench-side BRIDGE (no view).
 *
 * The render surface (public/debug-preview.html) now lives in a SHELL pane window (managed by shell-preview.ts), like the
 * app preview — a live runtime surface belongs in a floating window you can place, not an auxbar tab. This module stays
 * in the workbench realm (it needs the vscode `api` + debug events) and BRIDGES the debugger to that surface over the
 * hub (which spans realms): the debug worker publishes the render stream straight to the surface on
 * `tsval.preview.stream`; this opens/closes the shell window on session start/stop, resets the surface, keeps a
 * per-session buffer of the stream to replay when the surface (re)connects (so a window opened mid-session catches up),
 * and routes the surface's DOM events / time-travel requests back to the adapter.
 */
/* eslint-disable ts/no-explicit-any -- the vscode api is untyped here (captured from the hello extension) */
import type { Hub } from "@brianjenkins94/hub";
import type { PreviewMessage as ToPreview } from "./extensions/worker-pod/debug-protocol";

type Api = any;

export function installDebugPreview(getApi: () => Api, hub: Hub): void {
	// Mutations since the last reset, replayed to a surface that connects mid-session.
	let buffer: ToPreview[] = [];
	let historyLength = 0;

	// One subject carries the whole render stream (reset/mutation/rendered/history); control subjects are separate.
	const emit = (message: ToPreview): void => { hub.publish("tsval.preview.stream", message); };

	const api = getApi();

	// The worker's render stream, on its way to the surface: keep it for replay (not what we re-emit ourselves).
	hub.subscribe("tsval.preview.stream", (data, envelope) => {
		const message = data as ToPreview;

		if (envelope.from === hub.id) {
			return;
		}

		if (message.type === "mutation") {
			buffer.push(message);
		} else if (message.type === "history") {
			historyLength = message.length;
		}
	});

	// A tsval session starts a fresh tree — open the shell window and clear buffer + surface.
	api.debug.onDidStartDebugSession((session: any) => {
		if (session?.type !== "tsval") {
			return;
		}

		buffer = [];
		historyLength = 0;
		hub.publish("tsval.preview.open", {});
		emit({ "type": "reset" });
	});

	// Session ended — tell the shell to tear the window down.
	api.debug.onDidTerminateDebugSession((session: any) => {
		if (session?.type === "tsval") {
			hub.publish("tsval.preview.close", {});
		}
	});

	// Surface → debugger (relayed by the shell): a DOM event runs the guest handler (may hit a breakpoint); a
	// time-travel request rewinds. Route both to the active session's adapter.
	hub.subscribe("tsval.preview.event", (data: any) => {
		api.debug.activeDebugSession?.customRequest("dispatch", { "id": data.id, "event": data.event }).then(undefined, () => undefined);
	});
	hub.subscribe("tsval.preview.timeTravel", (data: any) => {
		api.debug.activeDebugSession?.customRequest("timeTravel", { "index": data.index }).then(undefined, () => undefined);
	});

	// The surface (re)connected → replay reset + buffer + history so a window opened mid-session is up to date.
	hub.subscribe("tsval.preview.hello", () => {
		emit({ "type": "reset" });

		for (const message of buffer) {
			emit(message);
		}

		if (historyLength > 0) {
			emit({ "type": "history", "length": historyLength });
		}
	});
}
