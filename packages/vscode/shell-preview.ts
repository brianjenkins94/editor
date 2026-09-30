/**
 * The preview WINDOWS — the display half of the live preview(s), hosted in the SHELL (top frame) so they can be
 * dragged anywhere in the viewport, beyond the confines of the editor iframe (which would clip a window created
 * inside it).
 *
 * The dev-server BACKEND stays in the app realm (preview.ts): it runs each dev server in the node worker and
 * registers the ServerBridge so the coi-serviceworker serves `/__virtual__/<port>/`. This module shows movable
 * WebAwesome windows (window.ts), each an iframe onto a server — as many per server as the user opens, like browser
 * tabs onto one dev server: each its own page (its own reload, DevTools, capability prompts, hub link). There's no
 * address bar: a window opens on the server's page, and another opens from the "new window" button or from the app
 * itself (a same-server `window.open` / `target="_blank"` link, which the injected tap hands up here). A window is
 * `preview:<port>` — the port's first — or `preview:<port>~<n>`. It applies what arrives over the hub:
 *   • `preview.open`  { port } → the server's window (a first one, or resurface the last used).
 *   • `preview.ready` { url, port } → the server is up at `url`: point every window of the port there.
 *   • `preview.window` { port, url? } → another window onto a running server (at `url`, a page of it, if given).
 *   • `preview.close` { port } → the server stopped: close every window of the port. Closing a window closes just it
 *     — but closing a server's last window stops the server (as it always did: it's how a preview is dismissed).
 *   • `preview.hmr.<port>` → post the HMR update into every window of the port (its injected client applies it).
 * Each iframe's injected console tap posts `{channel:"obs-log"}` up here; we reshape onto `$sys.log.<window>`.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { ArchSink } from "@brianjenkins94/observability";
import type { LinkPermissions, Transport } from "@brianjenkins94/hub";
import { createRpcClient, mapFrame, serve } from "@brianjenkins94/hub";
import { installWindowMessageProbe, scopeObservability } from "@brianjenkins94/observability";
import { AppWindow, ArrowDownToLine, ArrowUpToLine, Bug, Pause, Play, Redo2, RotateCcw, Unplug } from "lucide";
import type { DevtoolsPanel } from "./preview-devtools";
import { installPreviewCdp, openDevtoolsPanel } from "./preview-devtools";
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
// With DevTools open, the body splits: the app on top, DevTools docked below it (preview-devtools.ts).
const bodySplit = css({ "display": "flex", "flexDirection": "column", "& > iframe": { "flex": "1 1 0", "height": "auto", "minHeight": 0 } });
/** How much taller a preview window gets while DevTools is docked in it, so the app keeps its room. */
const DEVTOOLS_HEIGHT = 340;
/** How far each further window of a server opens from the one before it, so none opens exactly over another. */
const CASCADE = 32;
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

/**
 * What may cross the link an app in a preview joins the editor's tree through. Out of the app: its observability
 * (`$sys.log`, its startup backlog, `$sys.arch`), tab discovery answers, page-tool announcements, and RPC replies. Into it: architecture
 * sync, tab discovery, and calls to the tools it serves under its tab id (see observability's servePageTools). The
 * preview isn't a security boundary (same origin, unsandboxed — see ARCHITECTURE.md): this keeps an app's traffic
 * and the editor's apart, and nothing else of the app's leaves it.
 */
const PREVIEW_APP_PERMISSIONS: LinkPermissions = {
	"publish": ["$sys.log.>", "$sys.backlog.log", "$sys.arch.>", "tab.here", "page_tools.changed", "$rpc.reply.>"],
	"subscribe": ["$sys.arch.sync", "tab.discover", "$rpc.call.page_tools.*", "$rpc.call.tool.>", "$rpc.call.page_eval.*", "$rpc.call.page_query.*"]
};

/** One preview window: which server it shows, its window, the iframe, and the capability-prompt overlay. */
interface PreviewSurface {
	/** `preview:<port>` (the port's first window) or `preview:<port>~<n>`: its node, its hub link's peer, its log source,
	 *  and the scope its app's hubs are named under. */
	"id": string;
	/** The id without `preview:` (`5173`, `5173~2`): DevTools and CDP address it by this. */
	"key": string;
	"port": number;
	/** Which of the port's windows (1 for the first). */
	"index": number;
	/** When it was last opened or used — the port's window a prompt or the debug toolbar goes to. */
	"usedAt": number;
	"paneWindow": PaneWindow;
	"frame": HTMLIFrameElement;
	"promptEl": HTMLDivElement;
	/** The link an app's own hubs join the editor's tree through (see PREVIEW_APP_PERMISSIONS). */
	"unlinkApp": () => void;
	/** The window body's height without DevTools. */
	"height": number;
	/** Chrome DevTools, docked under the app while open. */
	"devtools"?: DevtoolsPanel;
	/** Serializes THIS window's capability prompts through its overlay, one at a time (another window's prompt can
	 *  show concurrently on its own overlay). */
	"promptChain": Promise<unknown>;
}

/** Wire the preview windows to a hub that reaches the app realm (the shell hub). Idempotent per shell. `sink` puts
 *  the windows on the live architecture diagram: each iframe's lifetime, what the shell posts into it, and — through
 *  a window message probe — everything any frame posts up to the shell, attributed to the iframe it came from. */
export function installShellPreview(hub: Hub, sink?: ArchSink): void {
	/** Every window, by id. */
	const surfaces = new Map<string, PreviewSurface>();
	/** Each running server (by port): where it serves, once it's up, and its one HMR subscription. */
	const servers = new Map<number, { "url"?: string; "offHmr": () => void }>();
	// The debug-run type shown in a window title. The live preview is the almostnode "production" run
	// (see production-adapter.ts); `preview.open` may override it.
	let previewMode = "production";
	// Latest active-debug-session state, published by debug-toolbar.ts. `port` is the preview the session drives (a
	// production run stamps its port); mirrored into that port's window's titlebar. Undefined for node/tsval sessions.
	let debugState = { "active": false, "type": "", "paused": false, "port": undefined as number | undefined };
	// For the preview shim's WS/WebRTC capability decisions — round-trips to the ext-host decider over the hub.
	const capRpc = createRpcClient(hub);

	const windowsOf = (port: number): PreviewSurface[] => [...surfaces.values()].filter((surface) => surface.port === port).sort((a, b) => a.index - b.index);
	const lastUsed = (list: PreviewSurface[]): PreviewSurface | undefined => list.toSorted((a, b) => b.usedAt - a.usedAt)[0];
	/** The port's window a prompt or the toolbar goes to: the one last used; with no port, the last used of all. */
	const windowFor = (port: number | undefined): PreviewSurface | undefined => lastUsed(port === undefined ? [...surfaces.values()] : windowsOf(port));
	const record = (to: string, label: string, bytes?: number): void => { sink?.record(sink.self, to, "message", label, bytes); };

	// The tsval debugger's render surface (debug-preview.html) gets its OWN window too — a live runtime surface, like
	// the app previews — but it's fed a mutation stream over the hub rather than a served URL, so it's tracked apart
	// from the server windows while reusing this module's window + debug-toolbar machinery. See
	// debug-preview-view.ts (the workbench-side bridge). The page is served next to the shell (public/debug-preview.html).
	const tsvalUrl = new URL("debug-preview.html", location.href).href;
	let tsvalSurface: { "paneWindow": PaneWindow; "frame": HTMLIFrameElement; "port"?: MessagePort } | undefined;

	const headerButton = (icon: Parameters<typeof iconSvg>[0], title: string, onClick: () => void, pressed?: boolean): HTMLElement => {
		const element = document.createElement("wa-button");

		element.setAttribute("appearance", "plain");
		element.setAttribute("size", "small");
		element.title = title;
		element.setAttribute("aria-label", title);
		element.innerHTML = iconSvg(icon, { "size": 15 });

		if (pressed !== undefined) {
			element.setAttribute("variant", pressed ? "brand" : "neutral");
			element.setAttribute("aria-pressed", String(pressed));
		}

		element.addEventListener("click", onClick);

		return element;
	};

	// Mirror the active debug session's toolbar (debug-toolbar.ts) into the titlebar of the window it drives —
	// the last used window of the session's preview port, or the last used window of all for a node/tsval session
	// with no port. VS Code has ONE active session at a time, so the toolbar lives on ONE window; clear every window
	// first so it never lingers on a previously-active one. pause/step show only for a stepping session (tsval);
	// restart + stop always.
	const renderDebugToolbar = (): void => {
		for (const surface of surfaces.values()) {
			// Every app window has "new window" and DevTools.
			surface.paneWindow.headerActions.replaceChildren(
				headerButton(AppWindow, "New window", () => { openWindow(surface.port, { "from": surface }); }),
				headerButton(Bug, surface.devtools === undefined ? "DevTools" : "Close DevTools", () => { toggleDevtools(surface); }, surface.devtools !== undefined)
			);
		}

		tsvalSurface?.paneWindow.headerActions.replaceChildren();

		if (!debugState.active) {
			return;
		}

		// A tsval session drives the tsval render window; every other session drives an app-preview window (its port's,
		// else the last used). So the step controls always sit on the window showing the run they drive.
		const target = debugState.type === "tsval" ? tsvalSurface : windowFor(debugState.port) ?? windowFor(undefined);
		const host = target?.paneWindow.headerActions;

		if (host === undefined) {
			return;
		}

		const button = (icon: Parameters<typeof iconSvg>[0], command: string, title: string, enabled = true): HTMLElement => {
			const element = headerButton(icon, title, () => { hub.publish("debug.command", { "command": command }); });

			if (!enabled) {
				element.setAttribute("disabled", "");
			}

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

	/** Dock DevTools under the app in `surface`'s window, or undock it. */
	const toggleDevtools = (surface: PreviewSurface): void => {
		if (surface.devtools === undefined) {
			surface.devtools = openDevtoolsPanel(hub, surface.key, surface.frame);
			surface.paneWindow.body.append(surface.devtools.element);
			surface.paneWindow.body.classList.add(bodySplit());
			// Taller by the panel, as far as the viewport below the window allows.
			const room = window.innerHeight - surface.paneWindow.body.getBoundingClientRect().top - 12;

			surface.paneWindow.setBodyHeight(Math.max(surface.height, Math.min(surface.height + DEVTOOLS_HEIGHT, room)));
			sink?.spawn({ "id": "devtools:" + surface.key, "label": "DevTools " + windowTitle(surface.id).slice("Preview ".length), "container": "previews", "detail": "Chrome DevTools frontend (chii)", "dynamic": true });
		} else {
			surface.devtools.dispose();
			surface.devtools = undefined;
			surface.paneWindow.body.classList.remove(bodySplit());
			surface.paneWindow.setBodyHeight(surface.height);
			sink?.terminate("devtools:" + surface.key);
		}

		renderDebugToolbar();
	};

	/** A running server's bookkeeping: its HMR goes into every window of the port — and every frame the app nests in
	 *  each (a game's instance iframes), each with its own HMR client, which acts only on modules it loaded (React Fast
	 *  Refresh, state preserved; anything else reloads that frame). */
	const ensureServer = (port: number): { "url"?: string; "offHmr": () => void } => {
		const existing = servers.get(port);

		if (existing !== undefined) {
			return existing;
		}

		const server = {
			"offHmr": hub.subscribe(`preview.hmr.${port}`, (message) => {
				for (const surface of windowsOf(port)) {
					record(surface.id, "hmr " + ((message as { "type"?: string } | null)?.type ?? "update"));

					if (surface.frame.contentWindow !== null) {
						for (const target of framesUnder(surface.frame.contentWindow)) {
							target.postMessage(message, "*");
						}
					}
				}
			})
		} as { "url"?: string; "offHmr": () => void };

		servers.set(port, server);

		return server;
	};

	/** Close one window. Its server keeps running while it has another; closing the last stops it (`preview.close`). */
	const closeWindow = (surface: PreviewSurface, { stopServer = true } = {}): void => {
		surface.unlinkApp();

		if (surface.devtools !== undefined) {
			surface.devtools.dispose();
			sink?.terminate("devtools:" + surface.key);
		}

		surface.paneWindow.element.remove();
		surfaces.delete(surface.id);
		hub.publish("page_tools.changed", { "preview": surface.port, "window": surface.id }); // its app's tools went with it
		sink?.terminate(surface.id);
		renderDebugToolbar();

		if (stopServer && windowsOf(surface.port).length === 0) {
			hub.publish("preview.close", { "port": surface.port });
		}
	};

	/** Open another window onto the server on `port` — at `url` (one of its pages) if given, else where the server
	 *  serves (once it's up). `from`: the window it was opened from, which it cascades from. */
	const openWindow = (port: number, { url, from }: { "url"?: string; "from"?: PreviewSurface } = {}): PreviewSurface => {
		const server = ensureServer(port);
		let index = 1;

		while (surfaces.has(windowId(port, index))) {
			index += 1;
		}

		const id = windowId(port, index);
		const height = Math.min(600, window.innerHeight - 120);
		const width = Math.min(520, window.innerWidth - 80);
		const anchor = (from ?? windowsOf(port).at(-1))?.paneWindow.element.getBoundingClientRect();
		const paneWindow = createPaneWindow({
			"title": `${windowTitle(id)} · ${previewMode}`, // titlebar states the window + which debug run type drives it
			"storageKey": id,
			"width": width,
			"height": height,
			...anchor === undefined ? {} : { "left": anchor.left + CASCADE, "top": anchor.top + CASCADE },
			"onClose": () => {
				const surface = surfaces.get(id);

				if (surface !== undefined) {
					closeWindow(surface);
				}
			}
		});
		const frame = document.createElement("iframe");

		paneWindow.body.appendChild(frame);
		paneWindow.body.classList.add(bodyRelative());

		const promptEl = document.createElement("div");

		promptEl.className = promptLayer();
		paneWindow.body.appendChild(promptEl);

		// The app's own hubs join the editor's tree here — its page's root hub links to us (observability's
		// linkPreviewHost) — so its logs, architecture and page tools reach the log plane and debug-mcp, as part of this
		// tab. Non-transit (two windows never reach each other), known by the window's id, confined to what an app needs
		// to be observed — and its observability scoped under that id as it arrives: every window of an app names its
		// hubs alike (`page`, …), and two windows' must not merge. A new page (a reload) re-reads its tools: announce the
		// change for debug-mcp.
		const unlinkApp = hub.link(frameTransport(frame, id), { "transit": false, "peer": id, "permissions": PREVIEW_APP_PERMISSIONS });

		frame.addEventListener("load", () => { hub.publish("page_tools.changed", { "preview": port, "window": id }); });

		const surface: PreviewSurface = { "id": id, "key": id.slice("preview:".length), "port": port, "index": index, "usedAt": Date.now(), "paneWindow": paneWindow, "frame": frame, "promptEl": promptEl, "unlinkApp": unlinkApp, "height": height, "promptChain": Promise.resolve() };

		// The window last touched is the port's for prompts and the debug toolbar.
		paneWindow.element.addEventListener("pointerdown", () => { surface.usedAt = Date.now(); }, { "capture": true });
		surfaces.set(id, surface);
		sink?.spawn({ "id": id, "label": windowTitle(id), "container": "previews", "detail": "/__virtual__/" + port + "/", "dynamic": true });

		const src = url ?? server.url;

		if (src !== undefined) {
			frame.src = src;
		}

		paneWindow.show();
		renderDebugToolbar(); // its header buttons (and the toolbar, if a session is already active)

		return surface;
	};

	hub.subscribe("preview.open", (data) => {
		const info = data as { "mode"?: string; "port"?: number } | null;
		const port = typeof info?.port === "number" ? info.port : DEFAULT_PORT;

		if (typeof info?.mode === "string" && info.mode !== "") {
			previewMode = info.mode;
		}

		const existing = windowFor(port);

		if (existing === undefined) {
			openWindow(port);
		} else {
			existing.usedAt = Date.now();
			existing.paneWindow.show();
		}
	});

	hub.subscribe("preview.ready", (data) => {
		const info = data as { "url"?: string; "port"?: number } | null;
		const port = typeof info?.port === "number" ? info.port : DEFAULT_PORT;

		if (typeof info?.url !== "string") {
			return;
		}

		ensureServer(port).url = info.url;

		for (const surface of windowsOf(port)) {
			surface.frame.src = info.url;
		}
	});

	hub.subscribe("preview.window", (data) => {
		const info = data as { "port"?: number; "url"?: string } | null;

		// Only onto a running server (a window has nothing to show otherwise).
		if (typeof info?.port === "number" && servers.has(info.port)) {
			openWindow(info.port, typeof info.url === "string" ? { "url": info.url } : {});
		}
	});

	hub.subscribe("preview.close", (data) => {
		const port = typeof (data as { "port"?: number } | null)?.port === "number" ? (data as { "port": number }).port : DEFAULT_PORT;

		for (const surface of windowsOf(port)) {
			closeWindow(surface, { "stopServer": false });
		}

		servers.get(port)?.offHmr();
		servers.delete(port);
	});

	hub.subscribe("debug.state", (data) => {
		const next = data as { "active"?: boolean; "type"?: string; "paused"?: boolean; "port"?: number };

		debugState = { "active": next.active === true, "type": next.type ?? "", "paused": next.paused === true, "port": typeof next.port === "number" ? next.port : undefined };
		renderDebugToolbar();
	});

	// The tsval render window — opened on session start, torn down on stop; the workbench bridge (debug-preview-view.ts)
	// drives it over the hub. It reuses createPaneWindow + renderDebugToolbar, so the step controls land on THIS window.
	const teardownTsval = (): void => {
		if (tsvalSurface !== undefined) {
			sink?.terminate("tsval-preview");
		}

		tsvalSurface?.port?.close();
		tsvalSurface?.paneWindow.element.remove();
		tsvalSurface = undefined;
		renderDebugToolbar();
	};

	const ensureTsval = (): void => {
		if (tsvalSurface !== undefined) {
			tsvalSurface.paneWindow.show();

			return;
		}

		const paneWindow = createPaneWindow({
			"title": "tsval Preview",
			"storageKey": "tsval-preview",
			"width": Math.min(460, window.innerWidth - 80),
			"height": Math.min(560, window.innerHeight - 120),
			"onClose": teardownTsval
		});
		const frame = document.createElement("iframe"); // .wa-win__body > iframe fills the body (window.css)

		frame.title = "tsval preview";
		frame.src = tsvalUrl;
		paneWindow.body.appendChild(frame);
		tsvalSurface = { "paneWindow": paneWindow, "frame": frame };
		sink?.spawn({ "id": "tsval-preview" });
		paneWindow.show();
		renderDebugToolbar(); // a tsval session may already be active when the window opens
	};

	hub.subscribe("tsval.preview.open", () => { ensureTsval(); });
	hub.subscribe("tsval.preview.close", () => { teardownTsval(); });
	hub.subscribe("tsval.preview.stream", (message) => {
		if (tsvalSurface?.port !== undefined) {
			record("tsval-preview", "stream " + ((message as { "type"?: string } | null)?.type ?? "message"));
			tsvalSurface.port.postMessage(message);
		}
	});

	// Chrome DevTools Protocol for each preview window's page, over the hub — the docked DevTools is one client of it.
	installPreviewCdp(hub, (key) => surfaces.get("preview:" + key)?.frame);

	/** Show ONE capability prompt as an overlay on `surface`'s preview window and resolve with the user's choice —
	 *  the running app is dimmed behind it. */
	const runOnePrompt = (surface: PreviewSurface, request: PromptRequest): Promise<PromptChoice> => {
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
	// is OUR WebAwesome overlay, never a VS Code notification. It shows on a window of the app that triggered it: the
	// request's `port` (threaded from the SW net gate / the WS-WebRTC shim — a port, not a window: the SW sees only
	// the address, the same in every window of it), on that port's last used window; or the last used window of all
	// for a decision not bound to a preview (a node/fs run). Serialized PER WINDOW so held requests queue on their own
	// overlay without blocking another window's.
	serve(hub, "capability.prompt", (request) => {
		const port = (request as { "port"?: number }).port;
		const surface = windowFor(typeof port === "number" ? port : undefined) ?? windowFor(undefined) ?? openWindow(DEFAULT_PORT);
		const result = surface.promptChain.then(() => runOnePrompt(surface, request as PromptRequest));

		surface.promptChain = result.catch(() => undefined);

		return result;
	});

	// Bridge from the injected tap (node-worker.ts OBS_TAP) — two channels, both from a preview iframe:
	//   • `cap-decide` : the WS/WebRTC shim asks whether to allow a connection the SW net gate can't see. Round-trip
	//     to the ext-host decider (`capability.decide`, keyed by the SOURCE surface's port so it attributes to that
	//     run + can prompt the TOFU overlay) and post the verdict back into the iframe. FAIL CLOSED (deny) on error.
	//   • `obs-log` : each console call / uncaught error → reshape into a LogRecord on `$sys.log.<window>`, so a
	//     preview iframe (otherwise invisible to the plane — app code logs through raw console) reaches the collector.
	//   • `open-window` : the app opened one of a server's pages as a new window → another preview window.
	if (sink !== undefined) {
		// Every message a frame posts up to the shell, by the frame it came from — known surfaces by name, anything
		// else by its path, so a new channel shows up on the diagram (and in conformance) without being declared here.
		installWindowMessageProbe(sink, (source) => {
			if (tsvalSurface?.frame.contentWindow === source) {
				return "tsval-preview";
			}

			for (const surface of surfaces.values()) {
				if (surface.devtools !== undefined && surface.devtools.frame.contentWindow === source) {
					return "devtools:" + surface.key;
				}
			}

			return surfaceOf(source)?.id;
		});
	}

	/** The preview window a message came from: its iframe's window, or any frame nested in it (the app's own iframes). */
	function surfaceOf(source: MessageEventSource | null): PreviewSurface | undefined {
		return [...surfaces.values()].find((surface) => isWithin(source, surface.frame.contentWindow));
	}

	globalThis.addEventListener("message", (event: MessageEvent) => {
		// The tsval render surface announced itself → hand it a MessagePort and bridge that port to the hub (same-realm
		// transfer here; the hub carries the cross-realm half to/from the workbench bridge).
		if ((event.data as { "type"?: string } | null)?.type === "preview-ready" && tsvalSurface !== undefined && event.source === tsvalSurface.frame.contentWindow) {
			const channel = new MessageChannel();

			tsvalSurface.port = channel.port1;
			channel.port1.onmessage = (message: MessageEvent): void => {
				const data = message.data as { "type"?: string; "id"?: unknown; "event"?: unknown; "index"?: unknown } | null;

				sink?.record("tsval-preview", sink.self, "message", (data?.type ?? typeof data) + " (port)");

				if (data?.type === "event") {
					hub.publish("tsval.preview.event", { "id": data.id, "event": data.event });
				} else if (data?.type === "timeTravel") {
					hub.publish("tsval.preview.timeTravel", { "index": data.index });
				} else if (data?.type === "hello") {
					hub.publish("tsval.preview.hello", {}); // → the workbench replays reset + buffer + history to us
				}
			};
			channel.port1.start();
			tsvalSurface.frame.contentWindow?.postMessage({ "type": "init" }, "*", [channel.port2]);
			record("tsval-preview", "init (+MessagePort)");

			return;
		}

		const source = surfaceOf(event.source);

		if (source === undefined) {
			return; // only our preview iframes (and the frames nested in them)
		}

		const { port } = source;
		const payload = event.data as { "channel"?: string; "id"?: number; "kind"?: string; "resource"?: string; "url"?: unknown; "record"?: { "level"?: string; "message"?: unknown; "attrs"?: Record<string, unknown> } } | null;

		// The app opened a page of a server as a new window (`window.open`, a `target="_blank"` link — the tap hands it
		// up instead of opening a browser tab): another preview window, onto that page. Only a page of a server that's
		// running here (this origin's `/__virtual__/<tab>/<port>/…`); anything else was left to the browser.
		if (payload?.channel === "open-window" && typeof payload.url === "string") {
			const target = previewPageOf(payload.url);

			if (target !== undefined && servers.has(target.port)) {
				openWindow(target.port, { "url": target.url, "from": source });
			}

			return;
		}

		if (payload?.channel === "cap-decide" && typeof payload.kind === "string") {
			const id = payload.id;
			const reply = (allow: boolean): void => {
				record(source.id, "cap-decision");
				(event.source as Window | null)?.postMessage({ "channel": "cap-decision", "id": id, "allow": allow }, "*");
			};

			capRpc.request("capability.decide", { "kind": payload.kind, "args": [payload.resource ?? ""], "port": port }, { "timeoutMs": 300000, "waitForResponderMs": 10000 })
				.then((allow) => { reply(allow !== false); })
				.catch(() => { reply(false); }); // can't reach the decider ⇒ fail closed

			return;
		}

		if (payload?.channel !== "obs-log" || payload.record === undefined) {
			return;
		}

		const { level, message, attrs } = payload.record;

		hub.publish(`${LOG_SUBJECT}.${source.id}`, {
			"kind": "log",
			"level": typeof level === "string" && OBS_LEVELS.has(level) ? level : "info",
			"message": typeof message === "string" ? message : String(message),
			"attrs": attrs ?? {},
			"context": { "source": source.id },
			"time": Date.now(),
			"depth": 0
		});
	});
}

/** `root` and every frame nested in it, depth first — cross-origin ones included (postMessage reaches them). */
function framesUnder(root: Window): Window[] {
	const found: Window[] = [root];

	try {
		for (const child of Array.from({ "length": root.frames.length }, (_, index) => root.frames[index])) {
			found.push(...framesUnder(child));
		}
	} catch { /* a frame we can't enumerate */ }

	return found;
}

/** Is `source` the window `root`, or a frame nested (at any depth) inside it? */
function isWithin(source: MessageEventSource | null, root: Window | null): boolean {
	if (root === null) {
		return false;
	}

	let current = source as Window | null;

	while (current !== null) {
		if (current === root) {
			return true;
		}

		let parent: Window;

		try {
			parent = current.parent;
		} catch {
			return false;
		}

		if (parent === current) {
			return false;
		}

		current = parent;
	}

	return false;
}

/** A server's `index`-th window: `preview:<port>` for the first, `preview:<port>~<n>` after it (no dots — ids become
 *  subject tokens, `$sys.log.<id>`). */
function windowId(port: number, index: number): string {
	return "preview:" + port + (index === 1 ? "" : "~" + index);
}

/** `preview:5173` → "Preview :5173"; `preview:5173~2` → "Preview :5173 (2)". */
function windowTitle(id: string): string {
	const [port, index] = id.slice("preview:".length).split("~");

	return "Preview :" + port + (index === undefined ? "" : " (" + index + ")");
}

/** A page of a server this editor runs: an address of this origin under `/__virtual__/<tab>/<port>/`. */
function previewPageOf(url: string): { "url": string; "port": number } | undefined {
	try {
		const parsed = new URL(url, location.href);
		const port = /^\/__virtual__\/[^/]+\/(\d+)\//u.exec(parsed.pathname)?.[1];

		return parsed.origin === location.origin && port !== undefined ? { "url": parsed.href, "port": Number(port) } : undefined;
	} catch {
		return undefined;
	}
}

/** A hub transport to whatever page `frame` holds: its window is looked up on every use — it's null until the frame is
 *  in the document, and a new page (a reload) is a new realm behind the same frame. What's sent while there's no
 *  window is dropped; hub's hello handshake recovers (the app's hub says hello when it links, and we answer). What
 *  arrives has its observability scoped under `scope` (the window's id — observability's scopeObservability). */
function frameTransport(frame: HTMLIFrameElement, scope: string): Transport {
	return {
		"send": (message) => { frame.contentWindow?.postMessage(message, location.origin); },
		"listen": (onMessage) => {
			const handler = (event: MessageEvent): void => {
				if (event.source !== null && event.source === frame.contentWindow && event.origin === location.origin) {
					onMessage(mapFrame(event.data, (hubFrame) => scopeObservability(hubFrame, scope) as typeof hubFrame));
				}
			};

			globalThis.addEventListener("message", handler);

			return () => { globalThis.removeEventListener("message", handler); };
		}
	};
}
