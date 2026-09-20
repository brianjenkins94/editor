/**
 * The preview WINDOWS — the display half of the live preview(s), hosted in the SHELL (top frame) so they can be
 * dragged anywhere in the viewport, beyond the confines of the editor iframe (which would clip a window created
 * inside it).
 *
 * The dev-server BACKEND stays in the app realm (preview.ts): it runs each dev server in the node worker and
 * registers the ServerBridge so the coi-serviceworker serves `/__virtual__/<port>/`. This module shows a movable
 * WebAwesome window PER PORT (window.ts) with an iframe pointed at that SW URL, so multiple concurrent previews (a
 * multi-server app, a multiplayer game) each get their own surface. It applies what arrives over the hub, keyed by
 * port:
 *   • `preview.open`  { port } → create/resurface that port's window.
 *   • `preview.ready` { url, port } → point that port's iframe at the URL it served.
 *   • `preview.close` { port } → tear that port's window down.
 *   • `preview.hmr.<port>` → post the HMR update into that port's iframe (its injected client applies it).
 * Each iframe's injected console tap posts `{channel:"obs-log"}` up here; we reshape onto `$sys.log.preview`.
 *
 * The capability-prompt overlay + mirrored debug toolbar attach to the MOST-RECENTLY-OPENED window (per-port
 * routing of those is a follow-up).
 */
import type { Hub } from "@brianjenkins94/hub";
import { serve } from "@brianjenkins94/hub";
import { ArrowDownToLine, ArrowUpToLine, Pause, Play, Redo2, RotateCcw, Unplug } from "lucide";
import { LOG_SUBJECT } from "./telemetry";
import { css, iconSvg } from "./theme";
import { createPaneWindow, type PaneWindow } from "./window";

/** Levels the preview tap emits — anything else is coerced to "info". */
const OBS_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);
/** The default preview port, used when an event omits one (single-preview back-compat). */
const DEFAULT_PORT = 5173;

// The capability-prompt overlay — a WebAwesome-styled scrim + card that fills a PREVIEW WINDOW body (not the whole
// shell): a TOFU decision clearly interrupts just the running app. Shown on `capability.prompt` (served below),
// resolved by the user's click.
const bodyRelative = css({ "position": "relative" });
const promptLayer = css({
	"position": "absolute", "inset": 0, "zIndex": 5,
	"display": "none", "alignItems": "center", "justifyContent": "center", "padding": "var(--wa-space-l)",
	"background": "color-mix(in srgb, var(--wa-color-surface-default) 74%, transparent)",
	"backdropFilter": "blur(2px)",
	"&.open": { "display": "flex" }
});
const promptCard = css({ "width": "min(420px, 100%)", "boxShadow": "var(--wa-shadow-l)" });
const promptTitle = css({ "display": "block", "fontWeight": "var(--wa-font-weight-semibold)", "marginBlockEnd": "var(--wa-space-2xs)" });
const promptScope = css({ "display": "block", "fontFamily": "var(--wa-font-family-code, monospace)", "fontSize": "12px", "wordBreak": "break-all", "color": "var(--wa-color-text-quiet)", "marginBlockEnd": "var(--wa-space-s)" });
const promptActions = css({ "display": "flex", "flexWrap": "wrap", "gap": "var(--wa-space-2xs)", "justifyContent": "flex-end" });

/** What the prompt overlay reports back (mirrors the ext-host decider's expectations). */
type PromptChoice = "allow-once" | "allow-always" | "deny" | "authorize";
interface PromptRequest { "kind"?: string; "scope"?: string; "resource"?: string; "dangerous"?: boolean; "redline"?: boolean }

/** One preview surface: its window, the iframe, the capability-prompt overlay, and its HMR unsubscribe. */
interface PreviewSurface {
	"paneWindow": PaneWindow;
	"frame": HTMLIFrameElement;
	"promptEl": HTMLDivElement;
	"offHmr": () => void;
}

/** Wire the preview windows to a hub that reaches the app realm (the shell hub). Idempotent per shell. */
export function installShellPreview(hub: Hub): void {
	const surfaces = new Map<number, PreviewSurface>();
	let primaryPort: number | undefined; // the window the overlay + debug toolbar attach to (most-recent)
	// Serializes concurrent prompts (several held fetches) through the overlay, one at a time.
	let promptChain: Promise<unknown> = Promise.resolve();
	// The debug-run type shown in a window title. The live preview is the almostnode "production" run
	// (see production-adapter.ts); `preview.open` may override it.
	let previewMode = "production";
	// Latest active-debug-session state, published by debug-toolbar.ts — mirrored into the primary window's toolbar.
	let debugState = { "active": false, "type": "", "paused": false };

	const primary = (): PreviewSurface | undefined => (primaryPort === undefined ? undefined : surfaces.get(primaryPort));

	// Mirror the active debug session's toolbar (debug-toolbar.ts) into the primary preview titlebar: pause/step
	// only for a stepping session (tsval), always restart + stop; each button rides `debug.command` to the command.
	const renderDebugToolbar = (): void => {
		const host = primary()?.paneWindow.headerActions;

		if (host === undefined) {
			return;
		}

		host.replaceChildren();

		if (!debugState.active) {
			return;
		}

		const button = (icon: Parameters<typeof iconSvg>[0], command: string, title: string, enabled = true): HTMLElement => {
			const element = document.createElement("wa-button");

			element.setAttribute("appearance", "plain");
			element.setAttribute("size", "small");
			element.title = title;
			element.setAttribute("aria-label", title);
			element.innerHTML = iconSvg(icon, { "size": 15 });

			if (!enabled) {
				element.setAttribute("disabled", "");
			}

			element.addEventListener("click", () => { hub.publish("debug.command", { "command": command }); });

			return element;
		};

		if (debugState.type === "tsval") {
			host.append(
				debugState.paused ? button(Play, "continue", "Continue") : button(Pause, "pause", "Pause"),
				button(Redo2, "stepOver", "Step Over", debugState.paused),
				button(ArrowDownToLine, "stepInto", "Step Into", debugState.paused),
				button(ArrowUpToLine, "stepOut", "Step Out", debugState.paused)
			);
		}

		host.append(button(RotateCcw, "restart", "Restart"), button(Unplug, "stop", "Stop"));
	};

	/** Create (or resurface) the window for `port`, and make it the primary (overlay/toolbar target). */
	const ensureSurface = (port: number): PreviewSurface => {
		const existing = surfaces.get(port);

		if (existing !== undefined) {
			primaryPort = port;

			return existing;
		}

		const paneWindow = createPaneWindow({
			"title": `Preview :${port} · ${previewMode}`, // titlebar states the port + which debug run type drives it
			"storageKey": `preview:${port}`,
			"width": Math.min(520, window.innerWidth - 80),
			"height": Math.min(600, window.innerHeight - 120),
			"onClose": () => { hub.publish("preview.close", { "port": port }); }
		});
		const frame = document.createElement("iframe");

		paneWindow.body.appendChild(frame);
		paneWindow.body.classList.add(bodyRelative());

		const promptEl = document.createElement("div");

		promptEl.className = promptLayer();
		paneWindow.body.appendChild(promptEl);

		// Each surface applies ITS port's HMR into ITS iframe (React Fast Refresh, state preserved).
		const offHmr = hub.subscribe(`preview.hmr.${port}`, (message) => { frame.contentWindow?.postMessage(message, "*"); });
		const surface: PreviewSurface = { "paneWindow": paneWindow, "frame": frame, "promptEl": promptEl, "offHmr": offHmr };

		surfaces.set(port, surface);
		primaryPort = port;
		renderDebugToolbar(); // in case a session is already active when the window opens

		return surface;
	};

	hub.subscribe("preview.open", (data) => {
		const info = data as { "mode"?: string; "port"?: number } | null;

		if (typeof info?.mode === "string" && info.mode !== "") {
			previewMode = info.mode;
		}

		ensureSurface(typeof info?.port === "number" ? info.port : DEFAULT_PORT).paneWindow.show();
	});

	hub.subscribe("preview.ready", (data) => {
		const info = data as { "url"?: string; "port"?: number } | null;
		const surface = surfaces.get(typeof info?.port === "number" ? info.port : DEFAULT_PORT);

		if (surface !== undefined && typeof info?.url === "string") {
			surface.frame.src = info.url;
		}
	});

	hub.subscribe("preview.close", (data) => {
		const port = typeof (data as { "port"?: number } | null)?.port === "number" ? (data as { "port": number }).port : DEFAULT_PORT;
		const surface = surfaces.get(port);

		if (surface === undefined) {
			return;
		}

		surface.offHmr();
		surface.paneWindow.element.remove();
		surfaces.delete(port);

		if (primaryPort === port) {
			primaryPort = [...surfaces.keys()].pop(); // fall back to another open preview, if any
		}

		renderDebugToolbar();
	});

	hub.subscribe("debug.state", (data) => {
		const next = data as { "active"?: boolean; "type"?: string; "paused"?: boolean };

		debugState = { "active": next.active === true, "type": next.type ?? "", "paused": next.paused === true };
		renderDebugToolbar();
	});

	/** Show ONE capability prompt as an overlay on the primary preview window (created if none) and resolve with the
	 *  user's choice — the running app is dimmed behind it. */
	const runOnePrompt = (request: PromptRequest): Promise<PromptChoice> => {
		const surface = primary() ?? ensureSurface(DEFAULT_PORT);

		surface.paneWindow.show();

		return new Promise<PromptChoice>((resolve) => {
			const layer = surface.promptEl;
			// Auto-deny if the prompt is ignored — matches the decider's RPC timeout so the overlay never stalls the
			// queue (an unanswered prompt fails closed on both ends).
			let timer: ReturnType<typeof setTimeout>;

			const finish = (choice: PromptChoice): void => {
				clearTimeout(timer);
				layer.classList.remove("open");
				layer.replaceChildren();
				resolve(choice);
			};

			timer = setTimeout(() => { finish("deny"); }, 300000);

			const card = document.createElement("wa-card");

			card.className = promptCard();

			const title = document.createElement("span");

			title.className = promptTitle();
			title.textContent = request.redline === true
				? "⛔ Redline capability"
				: request.dangerous === true ? "Review capability" : "Allow capability?";

			const scope = document.createElement("span");

			scope.className = promptScope();
			scope.textContent = request.scope ?? request.kind ?? "capability";

			const actions = document.createElement("div");

			actions.className = promptActions();

			const button = (label: string, variant: string, choice: PromptChoice): HTMLElement => {
				const element = document.createElement("wa-button");

				element.setAttribute("size", "small");
				element.setAttribute("variant", variant);
				element.textContent = label;
				element.addEventListener("click", () => { finish(choice); });

				return element;
			};

			if (request.redline === true) {
				// Catastrophic scope — a deliberate, one-time authorization only (never persisted; see decide.ts).
				actions.append(button("Deny", "neutral", "deny"), button("Authorize once", "danger", "authorize"));
			} else {
				actions.append(button("Deny", "neutral", "deny"), button("Allow once", "brand", "allow-once"), button("Allow always", "brand", "allow-always"));
			}

			card.append(title, scope, actions);
			layer.replaceChildren(card);
			layer.classList.add("open");
		});
	};

	// The ext-host decider (extensions/capabilities/decide.ts) round-trips here for every TOFU decision — the prompt
	// is OUR WebAwesome overlay in the preview window, never a VS Code notification. Serialized so several held
	// requests queue through the one overlay.
	serve(hub, "capability.prompt", (request) => {
		const result = promptChain.then(() => runOnePrompt(request as PromptRequest));

		promptChain = result.catch(() => undefined);

		return result;
	});

	// Bridge from the injected tap (node-worker.ts OBS_TAP) — two channels, both from a preview iframe:
	//   • `obs-log` : each console call / uncaught error → reshape into a LogRecord on `$sys.log.preview`, so a
	//     preview iframe (otherwise invisible to the plane — app code logs through raw console) reaches the collector.
	//   • `obs-cap` : a WebSocket / WebRTC endpoint the SW net gate can't see (Phase 1 capability capture) → publish
	//     `capability.observed`, keyed by the SOURCE surface's port so the ext host attributes it to that run.
	globalThis.addEventListener("message", (event: MessageEvent) => {
		const source = [...surfaces.entries()].find(([, surface]) => surface.frame.contentWindow === event.source);

		if (source === undefined) {
			return; // only our preview iframes
		}

		const port = source[0];
		const payload = event.data as { "channel"?: string; "record"?: { "level"?: string; "message"?: unknown; "attrs"?: Record<string, unknown>; "kind"?: string; "resource"?: string } } | null;

		if (payload?.record === undefined) {
			return;
		}

		if (payload.channel === "obs-cap" && typeof payload.record.kind === "string") {
			hub.publish("capability.observed", { "kind": payload.record.kind, "resource": payload.record.resource ?? "", "port": port });

			return;
		}

		if (payload.channel !== "obs-log") {
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
