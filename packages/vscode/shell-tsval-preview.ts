/**
 * The tsval debug preview WINDOW — the display half of the tsval React debugger's render surface, hosted in the SHELL
 * (top frame) so it can be dragged anywhere, like the app preview windows (shell-preview.ts). A live runtime surface
 * belongs in a floating window, not the auxbar.
 *
 * The surface page (public/debug-preview.html) is transport-agnostic: it announces `preview-ready` to its parent and
 * expects a MessagePort in an `init` message, then speaks the mutation/event protocol over it. So we host it in a pane
 * window, do the MessagePort handshake locally (same realm), and bridge that port to the workbench-side debugger over
 * the hub (debug-preview-view.ts):
 *   • `tsval.preview.open`  → create/resurface the window.
 *   • `tsval.preview.close` → tear it down.
 *   • `tsval.preview.stream` { …ToPreview } → post into the surface's port (reset/mutation/rendered/history).
 *   • surface → hub: `tsval.preview.event` (DOM event), `tsval.preview.timeTravel`, `tsval.preview.hello` (connected).
 */
import type { Hub } from "@brianjenkins94/hub";
import { createPaneWindow, type PaneWindow } from "./window";

/** Wire the tsval preview window to a hub that reaches the workbench (the shell hub). Idempotent per shell. */
export function installShellTsvalPreview(hub: Hub): void {
	// Served next to the shell page (public/debug-preview.html → <base>/debug-preview.html).
	const previewUrl = new URL("debug-preview.html", location.href).href;

	let paneWindow: PaneWindow | undefined;
	let frame: HTMLIFrameElement | undefined;
	let port: MessagePort | undefined;

	const teardown = (): void => {
		port?.close();
		port = undefined;
		paneWindow?.element.remove();
		paneWindow = undefined;
		frame = undefined;
	};

	const ensureWindow = (): void => {
		if (paneWindow !== undefined) {
			paneWindow.show();

			return;
		}

		paneWindow = createPaneWindow({
			"title": "tsval Preview",
			"storageKey": "tsval-preview",
			"width": Math.min(460, window.innerWidth - 80),
			"height": Math.min(560, window.innerHeight - 120),
			"onClose": teardown
		});

		frame = document.createElement("iframe");
		/* eslint-disable-next-line webawesome/no-inline-styles, webawesome/no-css-in-strings -- filling the window body with the render iframe: intrinsic geometry, not themeable chrome */
		frame.style.cssText = "display:block;border:0;width:100%;height:100%;background:#1e1e1e";
		frame.title = "tsval preview";
		frame.src = previewUrl;
		paneWindow.body.appendChild(frame);
		paneWindow.show();
	};

	// The surface iframe announces itself to us (its parent). Hand it a MessagePort and keep the other end to bridge the
	// hub. Same-realm transfer, so no cross-frame port juggling — the hub carries the cross-realm half.
	globalThis.addEventListener("message", (event: MessageEvent) => {
		if ((event.data as { "type"?: string } | null)?.type !== "preview-ready" || frame === undefined || event.source !== frame.contentWindow) {
			return;
		}

		const channel = new MessageChannel();

		port = channel.port1;
		port.onmessage = (message: MessageEvent): void => {
			const data = message.data as { "type"?: string; "id"?: unknown; "event"?: unknown; "index"?: unknown } | null;

			if (data?.type === "event") {
				hub.publish("tsval.preview.event", { "id": data.id, "event": data.event });
			} else if (data?.type === "timeTravel") {
				hub.publish("tsval.preview.timeTravel", { "index": data.index });
			} else if (data?.type === "hello") {
				hub.publish("tsval.preview.hello", {}); // → the workbench replays reset + buffer + history to us
			}
		};
		port.start();
		frame.contentWindow?.postMessage({ "type": "init" }, "*", [channel.port2]);
	});

	hub.subscribe("tsval.preview.open", () => { ensureWindow(); });
	hub.subscribe("tsval.preview.close", () => { teardown(); });
	hub.subscribe("tsval.preview.stream", (message) => { port?.postMessage(message); });
}
