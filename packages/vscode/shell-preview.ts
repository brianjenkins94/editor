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
import { serve } from "@brianjenkins94/hub";
import { ArrowDownToLine, ArrowUpToLine, Pause, Play, Redo2, RotateCcw, Unplug } from "lucide";
import { LOG_SUBJECT } from "./telemetry";
import { css, iconSvg } from "./theme";
import { createPaneWindow, type PaneWindow } from "./window";

/** Levels the preview tap emits — anything else is coerced to "info". */
const OBS_LEVELS = new Set(["trace", "debug", "info", "warn", "error", "fatal"]);

// The capability-prompt overlay — a WebAwesome-styled scrim + card that fills the PREVIEW WINDOW body (not the
// whole shell): a TOFU decision clearly interrupts just the running app. Shown on `capability.prompt` (served
// below), resolved by the user's click. The ext-host decider round-trips here and falls back to a VS Code
// notification only when no preview window is open.
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

/** Wire the preview window to a hub that reaches the app realm (the shell hub). Idempotent per shell. */
export function installShellPreview(hub: Hub): void {
	let paneWindow: PaneWindow | undefined;
	let frame: HTMLIFrameElement | undefined;
	let promptEl: HTMLDivElement | undefined; // the capability-prompt overlay, over the preview iframe
	// Serializes concurrent prompts (several held fetches) through the single overlay, one at a time.
	let promptChain: Promise<unknown> = Promise.resolve();
	// The debug-run type shown in the window title. The live preview is always the almostnode "production" run
	// (see production-adapter.ts); `preview.open` may override it.
	let previewMode = "production";
	// Latest active-debug-session state, published by debug-toolbar.ts — mirrored into the titlebar toolbar.
	let debugState = { "active": false, "type": "", "paused": false };

	const ensureWindow = (): void => {
		if (paneWindow !== undefined) {
			return;
		}

		paneWindow = createPaneWindow({
			"title": `Preview · ${previewMode}`, // titlebar states which debug run type is driving the preview
			"storageKey": "preview",
			"width": Math.min(520, window.innerWidth - 80),
			"height": Math.min(600, window.innerHeight - 120),
			"onClose": () => { hub.publish("preview.close"); }
		});
		frame = document.createElement("iframe");
		// The iframe fills the window body via window.ts's own CSS (`.wa-win__body > iframe`) — no inline style here.
		paneWindow.body.appendChild(frame);

		// The capability-prompt overlay lives ABOVE the iframe, filling the window body — so a TOFU decision
		// interrupts the running app (dimmed behind it), not the whole shell. Hidden until `capability.prompt`.
		paneWindow.body.classList.add(bodyRelative());
		promptEl = document.createElement("div");
		promptEl.className = promptLayer();
		paneWindow.body.appendChild(promptEl);

		renderDebugToolbar(); // in case a session is already active when the window opens
	};

	// Mirror the active debug session's toolbar (debug-toolbar.ts) into the preview titlebar: pause/step only for a
	// stepping session (tsval), always restart + stop; each button rides `debug.command` back to the real command.
	const renderDebugToolbar = (): void => {
		if (paneWindow === undefined) {
			return;
		}

		const host = paneWindow.headerActions;

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

		// Stepping applies only to a stepping debugger (tsval); the production preview is run-control only.
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

	hub.subscribe("preview.open", (data) => {
		const mode = (data as { "mode"?: string } | null)?.mode;

		if (typeof mode === "string" && mode !== "") {
			previewMode = mode;
		}

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
		promptEl = undefined;
	});

	hub.subscribe("debug.state", (data) => {
		const next = data as { "active"?: boolean; "type"?: string; "paused"?: boolean };

		debugState = { "active": next.active === true, "type": next.type ?? "", "paused": next.paused === true };
		renderDebugToolbar();
	});

	/** Show ONE capability prompt as the overlay and resolve with the user's choice. Ensures a preview window
	 *  exists so the prompt always has a home (the running app is dimmed behind it). */
	const runOnePrompt = (request: PromptRequest): Promise<PromptChoice> => {
		ensureWindow();
		paneWindow?.show();

		return new Promise<PromptChoice>((resolve) => {
			const layer = promptEl;

			if (layer === undefined) {
				resolve("deny"); // no surface to prompt on → fail closed
				return;
			}

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

	// The ext-host decider (extensions/capabilities/decide.ts) round-trips here for every TOFU decision — the
	// prompt is OUR WebAwesome overlay in the preview window, never a VS Code notification. Serialized so several
	// held requests queue through the one overlay.
	serve(hub, "capability.prompt", (request) => {
		const result = promptChain.then(() => runOnePrompt(request as PromptRequest));

		promptChain = result.catch(() => undefined);

		return result;
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
