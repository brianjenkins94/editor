/**
 * The preview WINDOW — the display half of the live preview, hosted in the SHELL (top frame) so it can be dragged
 * anywhere in the viewport, beyond the confines of the editor iframe (which would clip a window created inside it).
 *
 * The dev-server BACKEND stays in the app realm (preview.ts): it runs the dev server in the node worker and registers
 * the ServerBridge so the coi-serviceworker serves `/__virtual__/<port>/`. This module only shows a movable WebAwesome
 * window (window.ts) with an iframe pointed at that SW URL, and applies what arrives over the hub:
 *   • `preview.open`  → create/resurface the window (published by `npm run dev`; also on repeat runs).
 *   • `preview.ready` → the backend is up; set the iframe to the `{ url }` it served.
 *   • `preview.close` → tear the window down (Ctrl-C on `vite`, or the window's own close button).
 *   • `preview.hmr.>` → the worker's HMR updates; post them into the iframe (its injected client applies them).
 * The iframe's injected console tap posts `{channel:"obs-log"}` messages up to THIS window; we reshape them onto
 * `$sys.log.preview` so the preview still federates to the root collector like every other context.
 */
import type { Hub } from "@brianjenkins94/hub";
import { LOG_SUBJECT } from "./telemetry";
import { createPaneWindow, type PaneWindow } from "./window";

/** Levels the preview tap emits — anything else is coerced to "info". */
const OBS_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);

/** Wire the preview window to a hub that reaches the app realm (the shell hub). Idempotent per shell. */
export function installShellPreview(hub: Hub): void {
	let paneWindow: PaneWindow | undefined;
	let frame: HTMLIFrameElement | undefined;

	const ensureWindow = (): void => {
		if (paneWindow !== undefined) {
			return;
		}

		paneWindow = createPaneWindow({
			"title": "Preview",
			"storageKey": "preview",
			"width": Math.min(520, window.innerWidth - 80),
			"height": Math.min(600, window.innerHeight - 120),
			"onClose": () => { hub.publish("preview.close"); }
		});
		frame = document.createElement("iframe");
		// The iframe fills the window body via window.ts's own CSS (`.wa-win__body > iframe`) — no inline style here.
		paneWindow.body.appendChild(frame);
	};

	hub.subscribe("preview.open", () => {
		ensureWindow();
		paneWindow?.show();
	});

	hub.subscribe("preview.ready", (data) => {
		const url = (data as { "url"?: string } | null)?.url;

		if (frame !== undefined && typeof url === "string") {
			frame.src = url;
		}
	});

	hub.subscribe("preview.close", () => {
		paneWindow?.element.remove();
		paneWindow = undefined;
		frame = undefined;
	});

	// HMR: the worker publishes `preview.hmr.<port>`; post each update into the iframe, whose injected HMR client
	// applies it (React Fast Refresh, state preserved). The `>` wildcard avoids hard-coding the port here.
	hub.subscribe("preview.hmr.>", (message) => { frame?.contentWindow?.postMessage(message, "*"); });

	// Observability bridge: the injected tap (node-worker.ts OBS_TAP) posts each console call / uncaught error up as
	// `{channel:"obs-log", record}`. Reshape into a LogRecord and publish on `$sys.log.preview` so the preview iframe —
	// otherwise invisible to the plane (app code logs through raw console, not util/logger) — federates to the root
	// collector and out to debug-mcp like every other context.
	globalThis.addEventListener("message", (event: MessageEvent) => {
		if (frame === undefined || event.source !== frame.contentWindow) {
			return; // only our preview iframe
		}

		const payload = event.data as { "channel"?: string; "record"?: { "level"?: string; "message"?: unknown; "attrs"?: Record<string, unknown> } } | null;

		if (payload?.channel !== "obs-log" || payload.record === undefined) {
			return;
		}

		const { level, message, attrs } = payload.record;

		hub.publish(`${LOG_SUBJECT}.preview`, {
			"kind": "log",
			"level": typeof level === "string" && OBS_LEVELS.has(level) ? level : "info",
			"message": typeof message === "string" ? message : String(message),
			"attrs": attrs ?? {},
			"context": { "source": "preview" },
			"time": Date.now(),
			"depth": 0
		});
	});
}
