/**
 * The preview WINDOWS — the display half of the live preview(s), hosted in the SHELL (top frame) so they can be
 * dragged anywhere in the viewport, beyond the confines of the editor iframe (which would clip a window created
 * inside it).
 *
 * The dev-server BACKEND stays in the app realm (preview.ts): it runs each dev server in the node worker and
 * registers the ServerBridge so the coi-serviceworker serves `/__virtual__/<tab>/<port>/`. This module shows movable
 * WebAwesome windows (window.ts), each an iframe onto a server — as many per server as the user opens, like browser
 * tabs onto one dev server: each its own page (its own reload, DevTools, capability prompts, hub link). There's no
 * address bar: a window opens on the server's page, and another opens from the "new window" button or from the app
 * itself (a same-server `window.open` / `target="_blank"` link, which the injected tap hands up here). A window is
 * `preview:<port>` — the port's first — or `preview:<port>~<n>`. It applies what arrives over the hub:
 *   • `preview.open`  { port } → the server's window (a first one, or resurface the last used).
 *   • `preview.ready` { url, port } → the server is up at `url`: point every window of the port there.
 *   • `preview.close` { port } → the server stopped: close every window of the port. Closing a window closes just it
 *     — but closing a server's last window stops the server (as it always did: it's how a preview is dismissed).
 *   • `preview.hmr.<port>` → post the HMR update into every window of the port (its injected client applies it).
 * Each iframe's injected console tap posts `{channel:"obs-log"}` up here; we reshape onto `$sys.log.<window>`.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { ArchSink } from "@brianjenkins94/observability";
import type { LinkPermissions, Transport } from "@brianjenkins94/hub";
import { createRpcClient, rpcCallSubject, rpcReplySubject, serve, windowTransport } from "@brianjenkins94/hub";
import { installWindowMessageProbe, scopedTransport } from "@brianjenkins94/observability";
import { AppWindow, ArrowDownToLine, ArrowUpToLine, Bug, Pause, Play, Redo2, RotateCcw, SquareArrowDownLeft, SquareArrowOutUpRight } from "lucide";
import type { DevtoolsPanel } from "./preview-devtools";
import { installPreviewCdp, openDevtoolsPanel } from "./preview-devtools";
import { installAutoProfiler, installPreviewProfiler } from "./preview-profile";
import { css, iconSvg } from "./theme";
import { PREVIEW_HOST_MARK, PREVIEW_WINDOW_PREFIX, previewPageOf, windowId, windowTitle } from "./virtual-path";
import { createPaneWindow, type PaneWindow, type PaneWindowFactory } from "./window";

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
// What a preview window shows while its page is popped out into a browser window of its own.
const poppedLayer = css({
	"position": "absolute", "inset": 0, "zIndex": 4,
	"display": "flex", "flexDirection": "column", "alignItems": "center", "justifyContent": "center", "gap": "var(--wa-space-s)",
	"backgroundColor": "var(--wa-color-surface-default)", "color": "var(--wa-color-text-quiet)",
	"&[hidden]": { "display": "none" }
});
const promptTitle = css({ "display": "block", "fontWeight": "var(--wa-font-weight-semibold)", "marginBlockEnd": "var(--wa-space-2xs)" });
const promptScope = css({ "display": "block", "fontFamily": "var(--wa-font-family-code, monospace)", "fontSize": "12px", "wordBreak": "break-all", "color": "var(--wa-color-text-quiet)", "marginBlockEnd": "var(--wa-space-s)" });
const promptActions = css({ "display": "flex", "flexWrap": "wrap", "gap": "var(--wa-space-2xs)", "justifyContent": "flex-end" });

/** What the prompt overlay reports back (mirrors the ext-host decider's expectations). */
type PromptChoice = "allow-once" | "allow-always" | "deny" | "authorize";
interface PromptRequest { "kind"?: string; "scope"?: string; "resource"?: string; "dangerous"?: boolean; "redline"?: boolean }

/**
 * What may cross the link a preview window `id` joins the editor's tree through — its page tap's hub, and the app's
 * own behind it. Out of the window: its observability (`$sys.log`, its startup backlog, `$sys.arch`, `$sys.metrics`), tab discovery
 * answers, page-tool announcements, its replies to debug-mcp (the one caller of its tools), its runtime evidence
 * (`evidence.preview`), and its tap's calls (a capability decision, a new window — `preview.decide`, `preview.open`).
 * Into it: architecture sync, tab discovery, the editor asking its pages to report their evidence (`evidence.flush`),
 * calls to the tools it serves under its tab id (see observability's servePageTools), and the replies to its calls.
 * The preview isn't a security boundary (same origin, unsandboxed — see ARCHITECTURE.md): this keeps an app's traffic
 * and the editor's apart, and nothing else of the app's leaves it.
 */
function previewAppPermissions(id: string): LinkPermissions {
	return {
		"publish": ["$sys.log.>", "$sys.backlog.log", "$sys.arch.>", "$sys.metrics.>", "tab.here", "page_tools.changed", "evidence.preview", rpcReplySubject("debug-mcp"), rpcCallSubject("preview.decide"), rpcCallSubject("preview.open")],
		"subscribe": ["$sys.arch.sync", "tab.discover", "evidence.flush", ...["page_tools.*", "tool.>"].map((name) => rpcCallSubject(name)), rpcReplySubject(id)]
	};
}

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
	/** The link the window's hubs join the editor's tree through (see previewAppPermissions). */
	"unlinkApp": () => void;
	/** The (scoped) ids of the app's contexts that have reported through this window: ended when it closes. */
	"reporters": Set<string>;
	/** The window body's height without DevTools. */
	"height": number;
	/** Chrome DevTools, docked under the app while open. */
	"devtools"?: DevtoolsPanel;
	/** Serializes THIS window's capability prompts through its overlay, one at a time (another window's prompt can
	 *  show concurrently on its own overlay). */
	"promptChain": Promise<unknown>;
	/** Its page, popped out into a browser window of its own (named as this window, so the page's tap still knows
	 *  which it is; it links to its opener — this shell — instead of a parent). The frame shows `poppedEl` meanwhile. */
	"popup"?: { "window": Window; "url": string; "watch": ReturnType<typeof setInterval> };
	"poppedEl": HTMLDivElement;
}

/** Wire the preview windows to a hub that reaches the app realm (the shell hub). Idempotent per shell. `sink` puts
 *  the windows on the live architecture diagram: each iframe's lifetime, what the shell posts into it, and — through
 *  a window message probe — everything any frame posts up to the shell, attributed to the iframe it came from. */
export function installShellPreview(hub: Hub, sink?: ArchSink, makeWindow: PaneWindowFactory = createPaneWindow): void {
	// The preview pages' taps link here, however deep their frame is (see page-tap.ts's findHost).
	(window as unknown as Record<string, unknown>)[PREVIEW_HOST_MARK] = true;

	/** Every window, by id. */
	const surfaces = new Map<string, PreviewSurface>();
	/** Each port's next window number — only ever counts up (see openWindow). */
	const nextIndex = new Map<number, number>();
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
	/** Where a window's page is: its frame's, or the browser window it's popped out into. */
	const pageOf = (surface: PreviewSurface): Window | null => surface.popup?.window ?? surface.frame.contentWindow;
	const record = (to: string, label: string, bytes?: number): void => { sink?.record(sink.self, to, "message", label, bytes); };

	// The tsval debugger's render surface (debug-preview.html) gets its OWN window too — a live runtime surface, like
	// the app previews — but it's fed a mutation stream over the hub rather than a served URL, so it's tracked apart
	// from the server windows while reusing this module's window + debug-toolbar machinery. See
	// tsval-surface.ts (in the pod, beside the tsval adapter). The page is served next to the shell (public/debug-preview.html).
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
	// restart always (no stop: closing the window does that).
	const renderDebugToolbar = (): void => {
		for (const surface of surfaces.values()) {
			// Every app window has "new window", DevTools (docked under the frame, so not while popped out) and pop out.
			const devtools = headerButton(Bug, surface.devtools === undefined ? "DevTools" : "Close DevTools", () => { toggleDevtools(surface); }, surface.devtools !== undefined);

			if (surface.popup !== undefined) {
				devtools.setAttribute("disabled", "");
			}

			surface.paneWindow.headerActions.replaceChildren(
				headerButton(AppWindow, "New window", () => { openWindow(surface.port, { "from": surface }); }),
				devtools,
				surface.popup === undefined
					? headerButton(SquareArrowOutUpRight, "Pop out into its own window", () => { popOut(surface); })
					: headerButton(SquareArrowDownLeft, "Bring back", () => { bringBack(surface); })
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

		// No stop in the frame: closing a server's last window stops it, and an unplug icon read as "detach" — leaving the
		// server running somewhere — which nothing here does. (VS Code's own debug toolbar keeps its Stop.)
		host.append(button(RotateCcw, "restart", "Restart"));
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

	/**
	 * Pop a window's page out into a browser window of its own. Its page reloads there — a page can't move between
	 * windows — and its tap, finding no parent, links to its opener: this shell, which now takes the window's traffic
	 * from the popup (the window's link reads its page through `pageOf`). It's still served from this tab, so it lives
	 * as long as the editor does. Closing the popup brings the page back; so does "Bring back".
	 */
	const popOut = (surface: PreviewSurface): void => {
		let url = surface.frame.src;

		try {
			url = surface.frame.contentWindow?.location.href ?? url; // where it's got to, not where it started
		} catch { /* not readable: where it started */ }

		const rect = surface.frame.getBoundingClientRect();

		// Named as the window: the page's tap knows its window by its top frame's name. The frame gives the name up
		// first — `window.open` into a name an existing frame has navigates that frame instead of opening a window. Its
		// window's name, not its `name` attribute: the attribute names a frame once, when it's created.
		setFrameName(surface.frame, "");

		const popup = window.open(url, surface.id, `popup,width=${Math.max(320, Math.round(rect.width))},height=${Math.max(240, Math.round(rect.height))}`);

		if (popup === null) {
			setFrameName(surface.frame, surface.id);

			return; // blocked
		}

		if (surface.devtools !== undefined) {
			toggleDevtools(surface);
		}

		surface.popup = { "window": popup, "url": url, "watch": setInterval(() => { if (popup.closed) { bringBack(surface); } }, 500) };
		surface.frame.src = "about:blank";
		surface.poppedEl.hidden = false;
		record(surface.id, "pop out");
		renderDebugToolbar();
	};

	/** Bring a popped-out page back into its window, at the page it's on (or popped out at, if its window's gone). */
	const bringBack = (surface: PreviewSurface): void => {
		const popup = surface.popup;

		if (popup === undefined) {
			return;
		}

		let url = popup.url;

		try {
			// Where it's got to — if it's still on one of the server's pages (not a blank, or a page it navigated away to).
			const showing = popup.window.closed ? undefined : previewPageOf(popup.window.location.href);

			url = showing?.port === surface.port ? showing.url : url;
		} catch { /* not readable: where it popped out */ }

		clearInterval(popup.watch);
		surface.popup = undefined;
		popup.window.close();
		surface.poppedEl.hidden = true;
		setFrameName(surface.frame, surface.id); // kept across the navigation: the page's tap reads it
		surface.frame.src = url;
		record(surface.id, "bring back");
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

					const page = pageOf(surface);

					if (page !== null) {
						for (const target of framesUnder(page)) {
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
		// Its app's contexts end with it — they can't say so themselves (the frame goes, and the page's pagehide with
		// it): end every one that reported through this window.
		for (const reporter of surface.reporters) {
			hub.publish("$sys.arch." + reporter, { "reporter": reporter, "time": Date.now(), "ended": true });
		}

		surface.unlinkApp();

		if (surface.devtools !== undefined) {
			surface.devtools.dispose();
			sink?.terminate("devtools:" + surface.key);
		}

		if (surface.popup !== undefined) {
			clearInterval(surface.popup.watch);
			surface.popup.window.close();
		}

		surface.paneWindow.close();
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
		// Never reused: a window that closed keeps its id to itself, so its records never merge with a later window's.
		const index = nextIndex.get(port) ?? 1;

		nextIndex.set(port, index + 1);

		const id = windowId(port, index);
		const height = Math.min(600, window.innerHeight - 120);
		const width = Math.min(520, window.innerWidth - 80);
		const anchor = (from ?? windowsOf(port).at(-1))?.paneWindow.element.getBoundingClientRect();
		const paneWindow = makeWindow({
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

		// Its window's id, for the page's tap to tag the workers it starts with (see node-worker.ts's OBS_TAP).
		frame.name = id;
		paneWindow.body.appendChild(frame);
		paneWindow.body.classList.add(bodyRelative());

		const promptEl = document.createElement("div");

		promptEl.className = promptLayer();
		paneWindow.body.appendChild(promptEl);

		const poppedEl = document.createElement("div");
		const poppedNote = document.createElement("span");
		const poppedBack = document.createElement("wa-button");

		poppedEl.className = poppedLayer();
		poppedEl.hidden = true;
		poppedNote.textContent = "Open in its own window";
		poppedBack.setAttribute("size", "small");
		poppedBack.textContent = "Bring back";
		poppedBack.addEventListener("click", () => {
			const surface = surfaces.get(id);

			if (surface !== undefined) {
				bringBack(surface);
			}
		});
		poppedEl.append(poppedNote, poppedBack);
		paneWindow.body.appendChild(poppedEl);

		// The app's own hubs join the editor's tree here — its page's root hub links to us (observability's
		// linkPreviewHost) — so its logs, architecture and page tools reach the log plane and debug-mcp, as part of this
		// tab. Non-transit (two windows never reach each other), known by the window's id, confined to what an app needs
		// to be observed — and its observability scoped under that id as it arrives: every window of an app names its
		// hubs alike (`page`, …), and two windows' must not merge. A new page (a reload) re-reads its tools: announce the
		// change for debug-mcp.
		const reporters = new Set<string>();
		// (Its window looked up on each message: null until the frame is in the document, the popup while it's popped out.
		// What's sent while there's none is dropped; hub's hello handshake recovers.)
		const page = (): Window | null => {
			const surface = surfaces.get(id);

			return surface === undefined ? frame.contentWindow : pageOf(surface);
		};
		const unlinkApp = hub.link(scopedTransport(windowTransport(page, location.origin), id, {
			// The edge names the app's contexts: its page IS this window, the rest under it; the shell keeps its name.
			"keep": (other) => other === hub.id,
			// Who reported, so closing the window can end them all (see closeWindow).
			"onFrame": (scoped) => {
				const reporter = !("hub" in scoped) && scoped.subject.startsWith("$sys.arch.") ? (scoped.data as { "reporter"?: unknown } | undefined)?.reporter : undefined;

				if (typeof reporter === "string") {
					reporters.add(reporter);
				}
			}
		}), { "transit": false, "peer": id, "permissions": previewAppPermissions(id) });

		frame.addEventListener("load", () => { hub.publish("page_tools.changed", { "preview": port, "window": id }); });

		const surface: PreviewSurface = { "id": id, "key": id.slice(PREVIEW_WINDOW_PREFIX.length), "port": port, "index": index, "usedAt": Date.now(), "paneWindow": paneWindow, "frame": frame, "promptEl": promptEl, "unlinkApp": unlinkApp, "reporters": reporters, "height": height, "promptChain": Promise.resolve(), "poppedEl": poppedEl };

		// The window last touched is the port's for prompts and the debug toolbar.
		paneWindow.element.addEventListener("pointerdown", () => { surface.usedAt = Date.now(); }, { "capture": true });
		surfaces.set(id, surface);
		sink?.spawn({ "id": id, "label": windowTitle(id), "container": "previews", "detail": server.url, "dynamic": true });

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

		// A window that already shows one of this server's pages keeps it (a player's `play.html?match=…`, across a dev
		// server restart or a resurface); only one with nothing to show yet goes to where the server serves.
		const base = new URL(info.url, location.href);

		for (const surface of windowsOf(port)) {
			if (surface.popup !== undefined) {
				continue; // its page is in its own window, which keeps it
			}

			const showing = surface.frame.src === "" ? undefined : new URL(surface.frame.src, location.href);

			if (showing === undefined || showing.origin !== base.origin || !showing.pathname.startsWith(base.pathname)) {
				surface.frame.src = info.url;
			}
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

	// The tsval render window — opened on session start, torn down on stop; the pod (tsval-surface.ts)
	// drives it over the hub. It reuses createPaneWindow + renderDebugToolbar, so the step controls land on THIS window.
	const teardownTsval = (): void => {
		if (tsvalSurface !== undefined) {
			sink?.terminate("tsval-preview");
		}

		tsvalSurface?.port?.close();
		tsvalSurface?.paneWindow.close();
		tsvalSurface = undefined;
		renderDebugToolbar();
	};

	const ensureTsval = (): void => {
		if (tsvalSurface !== undefined) {
			tsvalSurface.paneWindow.show();

			return;
		}

		const paneWindow = makeWindow({
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
	// CPU profiles of each preview window's page, docked or popped out (preview-profile.ts) — asked for, and taken when
	// one keeps running slow.
	installPreviewProfiler(hub, (key) => {
		const surface = surfaces.get("preview:" + key);

		return surface === undefined ? undefined : pageOf(surface) ?? undefined;
	});
	installAutoProfiler(hub, () => [...surfaces.values()].map((surface) => ({ "key": surface.key, "port": surface.port, "page": pageOf(surface) ?? undefined })));

	/** Show ONE capability prompt as an overlay on `surface`'s preview window and resolve with the user's choice —
	 *  the running app is dimmed behind it. */
	const runOnePrompt = (surface: Pick<PreviewSurface, "paneWindow" | "promptEl">, request: PromptRequest): Promise<PromptChoice> => {
		// A window shown in a VS Code editor comes back into the dock first: the prompt is this page's own overlay.
		surface.paneWindow.dock?.();
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
	// is OUR WebAwesome overlay, never a VS Code notification. It shows on the window whose app triggered it: the
	// request's `window` when known (the WS/WebRTC shim's requests come from one), else a window of its `port` (the SW
	// net gate sees only the address, the same in every window of a server — so that port's last used window), else
	// the last used window of all (a decision not bound to a preview: a node/fs run). Serialized PER WINDOW so held
	// requests queue on their own overlay without blocking another window's.
	// With no preview window at all (a node script's decision, nothing previewed): a window of its own, holding just the
	// prompt — not a preview window onto a server nobody started.
	let promptOnly: { "paneWindow": PaneWindow; "promptEl": HTMLDivElement; "promptChain": Promise<unknown> } | undefined;
	const promptWindow = (): NonNullable<typeof promptOnly> => {
		if (promptOnly === undefined) {
			const paneWindow = createPaneWindow({ "title": "Capability request", "storageKey": "capability-prompt", "width": Math.min(460, window.innerWidth - 80), "height": 220, "onClose": () => { paneWindow.close(); } });
			const promptEl = document.createElement("div");

			promptEl.className = promptLayer();
			paneWindow.body.classList.add(bodyRelative());
			paneWindow.body.appendChild(promptEl);
			promptOnly = { "paneWindow": paneWindow, "promptEl": promptEl, "promptChain": Promise.resolve() };
		}

		return promptOnly;
	};

	serve(hub, "capability.prompt", (request) => {
		const { port, window: named } = request as { "port"?: number; "window"?: string };
		const surface = (typeof named === "string" ? surfaces.get(named) : undefined) ?? windowFor(typeof port === "number" ? port : undefined) ?? windowFor(undefined) ?? promptWindow();
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
		return [...surfaces.values()].find((surface) => isWithin(source, pageOf(surface)));
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
	});

	// A preview window's page tap asks over its window's link (page-tap.ts) — so the window is the one the link was
	// opened for, never one the page names.
	const windowOfCall = (from: string | undefined): PreviewSurface | undefined => (from === undefined ? undefined : surfaces.get(from));

	// A capability the service worker can't see (WebSocket, WebRTC), decided like any other — prompted in this window.
	serve(hub, "preview.decide", async (args, { from }) => {
		const surface = windowOfCall(from);
		const { kind, resource } = (args ?? {}) as { "kind"?: unknown; "resource"?: unknown };

		if (surface === undefined || typeof kind !== "string") {
			return false;
		}

		record(surface.id, "preview.decide");

		return capRpc.request("capability.decide", { "kind": kind, "args": [typeof resource === "string" ? resource : ""], "port": surface.port, "window": surface.id }, { "timeoutMs": 300000, "waitForResponderMs": 10000 })
			.then((allow) => allow !== false, () => false); // can't reach the decider ⇒ fail closed
	});

	// The app opened a page of a server as a new window (`window.open`, a `target="_blank"` link — the tap hands it up
	// instead of opening a browser tab): another preview window, onto that page. Only a page of a server that's running
	// here (this origin's `/__virtual__/<tab>/<port>/…`); anything else was left to the browser.
	serve(hub, "preview.open", (args, { from }) => {
		const surface = windowOfCall(from);
		const target = previewPageOf(String((args as { "url"?: unknown } | undefined)?.url));

		if (surface !== undefined && target !== undefined && servers.has(target.port)) {
			openWindow(target.port, { "url": target.url, "from": surface });
		}
	});
}

/** Rename a frame's browsing context (what `window.open` targets and its pages read as `window.name`) — the frame's
 *  `name` attribute only names it at creation. Same origin, so its window is ours to rename. */
function setFrameName(frame: HTMLIFrameElement, name: string): void {
	frame.name = name;

	if (frame.contentWindow !== null) {
		frame.contentWindow.name = name;
	}
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


