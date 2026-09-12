/**
 * tsval debug preview — workbench-side glue + the dumb-iframe view.
 *
 * Runs INSIDE the workbench iframe (it needs both the vscode `api` and DOM). Two responsibilities:
 *
 *  1. A custom PANEL view (`registerCustomView`, real DOM — NOT a webview, so it composites under our
 *     coi-serviceworker single-origin harness where webviews can't) whose body is just a `<iframe>` pointing
 *     at the standalone `debug-preview.html`. The view is intentionally a dumb container: all render logic
 *     lives in that page, so the same page can be popped out into its own window (the "Open in new window"
 *     action) with zero code changes.
 *
 *  2. The bridge between the debugger and every preview surface (the embedded iframe + any popped-out windows):
 *     the debug adapter (extensions/worker-pod/debug-adapter.ts) emits the M3c render stream as DAP custom
 *     events (`tsvalMutation`/`tsvalRendered`/`tsvalHistory`); we forward them over a MessagePort to each
 *     surface, and route DOM events the surface reports back to the adapter via `customRequest("dispatch")`.
 *
 * Each surface announces itself with a `preview-ready` window message; we answer by transferring it a
 * MessagePort. Because that handshake is identical for an embedded iframe and a `window.open`ed window, pop-out
 * is transparent. A per-session mutation buffer is replayed to a surface that connects mid-session (so a
 * window popped open after rendering started still shows the current tree).
 */
/* eslint-disable ts/no-explicit-any */
import { registerCustomView, ViewContainerLocation } from "@brianjenkins94/monaco-vscode-api/main";

type Api = any;

/** Host→preview messages (mirrors debug-preview.html). `mutation` carries one debug-react.ts Mutation. */
type ToPreview =
	| { "type": "mutation"; "mutation": unknown }
	| { "type": "rendered" }
	| { "type": "history"; "length": number }
	| { "type": "reset" };

/** The URL of the standalone preview page, resolved against the workbench iframe location so it honours the
 *  deploy base (host.html is at `<base>/__vscode__/host.html`; the page is copied to `<base>/debug-preview.html`). */
function previewUrl(): string {
	return new URL("../debug-preview.html", location.href).href;
}

export function installDebugPreview(getApi: () => Api): void {
	// Each connected surface: the port we keep, plus its window so we can prune it when it goes away.
	const surfaces = new Set<{ "port": MessagePort; "win": Window }>();
	// Mutations since the last reset, replayed to a surface that connects mid-session.
	let buffer: ToPreview[] = [];
	let historyLength = 0;

	function broadcast(message: ToPreview): void {
		for (const surface of surfaces) {
			try {
				surface.port.postMessage(message);
			} catch {
				surfaces.delete(surface);
			}
		}
	}

	/** Wire a freshly announced surface: hand it a port, replay the session so far, and route its events back. */
	function connect(win: Window): void {
		const channel = new MessageChannel();
		const surface = { "port": channel.port1, "win": win };
		surfaces.add(surface);

		channel.port1.onmessage = (event: MessageEvent): void => {
			const data = event.data;

			if (data?.type === "event") {
				// A DOM event on node `id` → run the guest handler in the worker (may hit a breakpoint, M3b).
				getApi().debug.activeDebugSession?.customRequest("dispatch", { "id": data.id, "event": data.event }).then(undefined, () => undefined);
			} else if (data?.type === "timeTravel") {
				getApi().debug.activeDebugSession?.customRequest("timeTravel", { "index": data.index }).then(undefined, () => undefined);
			}
			// `hello` needs no action — the replay below already primed this surface.
		};

		channel.port1.start();
		win.postMessage({ "type": "init" }, "*", [channel.port2]);

		// Replay the current session so a late-joining surface (e.g. a just-popped-out window) is up to date.
		channel.port1.postMessage({ "type": "reset" });

		for (const message of buffer) {
			channel.port1.postMessage(message);
		}

		if (historyLength > 0) {
			channel.port1.postMessage({ "type": "history", "length": historyLength });
		}
	}

	// A surface (embedded iframe → our parent-message; popped window → our opener-message) is ready.
	window.addEventListener("message", (event: MessageEvent) => {
		if (event.data?.type === "preview-ready" && event.source !== null) {
			connect(event.source as Window);
		}
	});

	// Debugger → surfaces: forward the adapter's DAP custom events, buffering for replay.
	const api = getApi();

	api.debug.onDidReceiveDebugSessionCustomEvent((event: { "event": string; "body": any }) => {
		if (event.event === "tsvalMutation") {
			const message: ToPreview = { "type": "mutation", "mutation": event.body.mutation };
			buffer.push(message);
			broadcast(message);
		} else if (event.event === "tsvalRendered") {
			broadcast({ "type": "rendered" });
		} else if (event.event === "tsvalHistory") {
			historyLength = event.body.length;
			broadcast({ "type": "history", "length": historyLength });
		}
	});

	// A new debug session starts a fresh tree — clear the buffer and every surface.
	api.debug.onDidStartDebugSession(() => {
		buffer = [];
		historyLength = 0;
		broadcast({ "type": "reset" });
	});

	registerCustomView({
		"id": "tsval.preview",
		"name": "tsval Preview",
		"order": 1,
		"location": ViewContainerLocation.AuxiliaryBar,
		"renderBody": (container: HTMLElement) => {
			container.style.height = "100%";
			container.style.padding = "0";

			const frame = document.createElement("iframe");
			frame.src = previewUrl();
			frame.style.cssText = "display:block;border:0;width:100%;height:100%;background:#1e1e1e";
			frame.title = "tsval preview";
			container.appendChild(frame);

			return {
				"dispose": (): void => {
					for (const surface of surfaces) {
						if (surface.win === frame.contentWindow) {
							surfaces.delete(surface);
						}
					}

					frame.remove();
				}
			};
		},
		"actions": [
			{
				"id": "tsval.preview.popOut",
				"title": "Open Preview in New Window",
				"icon": "multiple-windows",
				"run": async (): Promise<void> => {
					// Same page, own window — it announces via `opener` and connects through the same handshake.
					// Needs the click's transient activation; a blocked popup returns null.
					const opened = window.open(previewUrl(), "tsval-preview", "popup,width=460,height=560");

					if (opened === null) {
						getApi().window.showWarningMessage("tsval preview: allow popups for this site to open the preview in a new window.");
					}
				}
			}
		]
	});
}
