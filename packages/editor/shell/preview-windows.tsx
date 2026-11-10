/** @jsxImportSource preact */
/**
 * The preview windows, in the shell (the top frame) so they can be dragged anywhere, beyond the editor's iframe: movable
 * windows onto a dev server (`preview.ready`, workbench/node-runner.ts), each an iframe on its address, as many per server
 * as you open. There's no address bar: a window opens on the server's page.
 *
 * Each server's hot updates (`preview.hmr.<port>`) are posted into every window of it, and every frame its app nests, where
 * the dev server's client in the page applies them. Closing a window closes just it, but closing a server's last one stops
 * the server (`preview.close`), which is how a preview is dismissed; a server stopped elsewhere closes its windows.
 *
 * Each window has Chrome's DevTools for its page, docked under it (preview-devtools.ts), from its title bar; the same
 * DevTools protocol is a hub request (`preview.cdp`), which agents use too. And a CPU profile of its page, asked for from
 * its title bar (or `preview.profile`), kept with its server's run (preview-profile.ts). And the debug toolbar of
 * the session that drives a window's page (its dev server's own, or a recorded call of it being stepped), in the title bar
 * of the window of its port you used last (extensions/bridge/debug-toolbar.ts tells which, `debug.state`).
 *
 * And in-editor Playwright's way onto a page (`playwright.run`, a test file's in the debugger: packages/playwright): each
 * test's page has a window of its own while it runs, so tests can run at once: the one it opens by going somewhere, or else
 * the one you've used last that no other page has. A preview's frame is same-origin with the shell, so its DOM is right here.
 */
import type { PlaywrightCall } from "@brianjenkins94/editor-api/runtime";
import type { Hub } from "@brianjenkins94/hub";
import type { ShellFeature } from "./feature";
import type { DevtoolsPanel } from "./preview-devtools";
import { appWindow } from "@brianjenkins94/app-window";
import { serve } from "@brianjenkins94/hub";
import { AppWindow, ArrowDownToLine, ArrowUpToLine, Bug, Gauge, Pause, Play, Redo2, RotateCcw } from "lucide";
import { render } from "preact";
import { useState } from "preact/hooks";
import { previewBody, previewFrame } from "theme/styles/shell";
import { createStore, useStore } from "./feature";
import { Icon } from "./icon";
import { askInWindow, type PreviewAsk } from "./preview-ask";
import { installPreviewCdp, openDevtoolsPanel } from "./preview-devtools";
import { createPreviewProfiler, installPreviewProfiler, PROFILE_MS } from "./preview-profile";
import "theme/components/button";

/** How far each further window of a server opens from the one before it, so none opens exactly over another. */
const CASCADE = 32;
const FIRST_AT = 96;
const WIDTH = 720;
const HEIGHT = 480;
const FEWEST_PLACES = 4;
/** How much taller a window gets while DevTools is docked in it, as far as the page below it allows, so the app keeps
 *  its room. */
const DEVTOOLS_HEIGHT = 340;

/** Where the `opened`th window opens: the cascade goes round again before a window would leave the page, as what's off the
 *  page stops being drawn (xterm's rendering pauses, for one) and can't be reached. (`CASCADE` of room kept for the title
 *  bar.) On a page too small for a whole window, still `FEWEST_PLACES`, so none opens exactly over the last. */
function cascadeAt(opened: number): number {
	const room = Math.min(window.innerWidth - WIDTH, window.innerHeight - HEIGHT - CASCADE) - FIRST_AT;

	return FIRST_AT + (opened % Math.max(FEWEST_PLACES, Math.floor(room / CASCADE) + 1)) * CASCADE;
}

interface Server { "url": string; "windows": Set<HTMLElement>; "opened": number; "offUpdates": () => void }

/** A window with no server (a test's page, before it goes anywhere): its own, as a server's port is. */
const NO_SERVER = 0;

/** The active debug session, as the bridge tells it (`debug.state`), and the window whose title bar has its toolbar. */
interface DebugState { "active": boolean; "type": string; "paused": boolean; "port"?: number }

const debugging = createStore<{ "state": DebugState; "window"?: string }>({ "state": { "active": false, "type": "", "paused": false } });

/** The active session's toolbar, in the title bar of the window it drives: continue or pause and the steps for one that
 *  steps (any but a dev server's own), and restart. No stop: closing the window does that, as it always has. */
function DebugButtons({ window, command }: { "window": string; "command": (name: string) => void }) {
	const { state, "window": target } = useStore(debugging);

	if (target !== window) {
		return null;
	}

	const button = (icon: Parameters<typeof Icon>[0]["node"], name: string, title: string, enabled = true) => (
		<wa-button appearance="plain" size="small" title={title} aria-label={title} disabled={!enabled} onClick={() => { command(name); }}><Icon node={icon} /></wa-button>
	);

	return (
		<>
			{state.type !== "preview" && (
				<>
					{state.paused ? button(Play, "continue", "Continue") : button(Pause, "pause", "Pause")}
					{button(Redo2, "stepOver", "Step Over", state.paused)}
					{button(ArrowDownToLine, "stepInto", "Step Into", state.paused)}
					{button(ArrowUpToLine, "stepOut", "Step Out", state.paused)}
				</>
			)}
			{button(RotateCcw, "restart", "Restart")}
		</>
	);
}

/** A window's title bar's own controls: the debug toolbar of the session driving its page, another window onto its
 *  server, a CPU profile of its page, and DevTools docked under its page or not. */
function WindowActions({ window, command, another, profile, devtools }: { "window": string; "command": (name: string) => void; "another": () => void; "profile": () => Promise<unknown>; "devtools": () => boolean }) {
	const [docked, setDocked] = useState(false);
	const [profiling, setProfiling] = useState(false);
	const title = `Profile its page for ${String(PROFILE_MS / 1000)} seconds`;

	return (
		<>
			<DebugButtons window={window} command={command} />
			<wa-button appearance="plain" size="small" title="Another window onto this server" aria-label="Another window onto this server" onClick={another}><Icon node={AppWindow} /></wa-button>
			<wa-button
				appearance="plain"
				size="small"
				title={profiling ? "Profiling its page…" : title}
				aria-label={profiling ? "Profiling its page" : "Profile its page"}
				loading={profiling}
				onClick={() => {
					setProfiling(true);
					// (what it found goes where every profile does: workbench/profile-files.ts; a failure is the profiler's span's)
					void profile().catch(() => undefined).finally(() => { setProfiling(false); });
				}}
			>
				<Icon node={Gauge} />
			</wa-button>
			<wa-button appearance={docked ? "filled" : "plain"} size="small" title={docked ? "Close DevTools" : "DevTools"} aria-label={docked ? "Close DevTools" : "DevTools"} onClick={() => { setDocked(devtools()); }}><Icon node={Bug} /></wa-button>
		</>
	);
}

/** A window's frame and every frame its app nests: each has a client of its own, which acts only on what it loaded. */
function framesUnder(root: Window): Window[] {
	return [root, ...Array.from({ "length": root.frames.length }, (_, index) => framesUnder(root.frames[index]!)).flat()];
}

function install(hub: Hub): void {
	const servers = new Map<number, Server>();
	/** The windows, the one last used last. */
	const used: HTMLElement[] = [];
	/** What closes each window's DevTools, while it's docked. */
	const undock = new WeakMap<HTMLElement, () => void>();
	const profile = createPreviewProfiler(hub);

	/** A window, as profiling it has it. */
	const profiled = (element: HTMLElement): { "key": string; "port": number; "page": Window } | undefined => {
		const page = element.querySelector("iframe")?.contentWindow;

		return page === null || page === undefined ? undefined : { "key": element.dataset["previewWindow"]!, "port": Number(element.dataset["previewPort"]), "page": page };
	};

	/** A window by its key, else the port's you used last, else the one you used last. */
	const windowAt = ({ key, port }: { "key"?: string; "port"?: number }): HTMLElement | undefined => (key === undefined
		? used.findLast((each) => port === undefined || servers.get(port)?.windows.has(each) === true)
		: used.find((each) => each.dataset["previewWindow"] === key));

	/** The window the active session's toolbar goes in: its port's you used last. */
	const retarget = (): void => {
		const { state } = debugging.get();
		const windows = state.port === undefined ? undefined : servers.get(state.port)?.windows;
		const target = state.active ? used.findLast((element) => windows?.has(element) === true) : undefined;

		if (target?.dataset["previewWindow"] !== debugging.get().window) {
			debugging.set({ "window": target?.dataset["previewWindow"] });
		}
	};

	const useWindow = (element: HTMLElement): void => {
		used.splice(used.indexOf(element) >>> 0, 1);
		used.push(element);
		retarget();
	};

	const open = (port: number): HTMLElement | undefined => {
		const server = servers.get(port);

		if (server === undefined) {
			return undefined;
		}

		const frame = document.createElement("iframe");
		const body = document.createElement("div");
		const actions = document.createElement("div");
		const at = cascadeAt(server.opened);
		let devtools: DevtoolsPanel | undefined;

		frame.className = previewFrame();
		frame.title = port === NO_SERVER ? "Preview" : `Preview :${String(port)}`;
		frame.allow = "cross-origin-isolated";
		frame.src = server.url;
		// (the page, and DevTools under it while it's docked)
		body.className = `wa-stack wa-gap-0 ${previewBody()}`;
		body.append(frame);

		const element = appWindow({
			"label": port === NO_SERVER ? "Preview" : `Preview :${String(port)}`,
			"closable": true,
			"width": WIDTH,
			"bodyHeight": HEIGHT,
			"headerActions": [actions],
			"children": [body],
			"onClose": () => {
				undock.get(element)?.();
				element.remove();
				used.splice(used.indexOf(element) >>> 0, 1);
				server.windows.delete(element);
				retarget();

				if (server.windows.size === 0 && port !== NO_SERVER) {
					hub.publish("preview.close", { "port": port });
				}
			}
		});

		element.dataset["previewPort"] = String(port);
		// (its key: `5173~2` is the port's second window, as DevTools and `preview.cdp` know it)
		element.dataset["previewWindow"] = `${String(port)}~${String(server.opened + 1)}`;
		render(<WindowActions
			window={element.dataset["previewWindow"]}
			command={(name) => { hub.publish("debug.command", { "command": name }); }}
			another={() => { open(port); }}
			profile={async () => {
				const found = profiled(element);

				return found === undefined ? undefined : profile(found);
			}}
			devtools={() => {
				if (devtools === undefined) {
					devtools = openDevtoolsPanel(hub, element.dataset["previewWindow"]!, frame);
					undock.set(element, devtools.dispose);
					body.append(devtools.element);
					element.setAttribute("body-height", String(Math.max(HEIGHT, Math.min(HEIGHT + DEVTOOLS_HEIGHT, window.innerHeight - element.getBoundingClientRect().top - FIRST_AT))));
				} else {
					devtools.dispose();
					undock.delete(element);
					devtools = undefined;
					element.setAttribute("body-height", String(HEIGHT));
				}

				return devtools !== undefined;
			}}
		/>, actions);
		element.initialLeft = at;
		element.initialTop = at;
		server.opened += 1;
		server.windows.add(element);
		document.body.append(element);
		useWindow(element);
		element.addEventListener("pointerdown", () => {
			useWindow(element);
		});

		return element;
	};

	// The active debug session, for its toolbar (extensions/bridge/debug-toolbar.ts): asked now, as the bridge may be first.
	hub.subscribe("debug.state", (data) => {
		debugging.set({ "state": data as DebugState });
		retarget();
	});
	hub.publish("debug.state.ask", {});

	// The DevTools protocol onto a window's page.
	installPreviewCdp(hub, (asked) => {
		const element = windowAt(asked);
		const frame = element?.querySelector("iframe");

		return element === undefined || frame === null || frame === undefined ? undefined : { "key": element.dataset["previewWindow"]!, "frame": frame };
	});

	// A profile of a window's page, asked for.
	installPreviewProfiler(hub, profile, (asked) => {
		const element = windowAt(asked);

		return element === undefined ? undefined : profiled(element);
	});

	// A page's runtime evidence (previews/page-script.ts posts it here, the window its preview is in): on to the core, as
	// its server's (evidence.ts finds the run by the port). By the port the page says, as its last report comes as its
	// window closes, when it's no longer among the windows here.
	addEventListener("message", (event: MessageEvent) => {
		const { channel, port, page, modules, packages } = (event.data ?? {}) as { "channel"?: unknown; "port"?: unknown; "page"?: unknown; "modules"?: unknown; "packages"?: unknown };

		if (channel === "editor-evidence" && event.origin === location.origin && typeof port === "number") {
			hub.publish("evidence.preview", { "window": `preview:${String(port)}`, "page": page, "modules": modules, "packages": packages });
		}
	});

	// A page's recorded stops (a breakpoint in its code: RUNNING.md), each report every hit so far: on to the editor's Margin,
	// by the preview's session (workbench/preview-session.ts).
	addEventListener("message", (event: MessageEvent) => {
		const { channel, port, stops } = (event.data ?? {}) as { "channel"?: unknown; "port"?: unknown; "stops"?: unknown };

		if (channel === "editor-stops" && event.origin === location.origin && typeof port === "number" && Array.isArray(stops)) {
			hub.publish("stops.preview", { "port": port, "stops": stops });
		}
	});

	// A server's run ended: its pages report now (its windows may stay open, the page left as it was).
	hub.subscribe("evidence.flush", (data) => {
		const { port } = (data ?? {}) as { "port"?: unknown };

		for (const frame of document.querySelectorAll<HTMLIFrameElement>(`[data-preview-port="${String(port)}"] iframe`)) {
			for (const target of frame.contentWindow === null ? [] : framesUnder(frame.contentWindow)) {
				target.postMessage({ "channel": "editor-evidence-flush" }, location.origin);
			}
		}
	});

	hub.subscribe("preview.ready", (data) => {
		const { port, url } = data as { "port": number; "url": string };

		servers.set(port, {
			"url": url,
			"windows": new Set(),
			"opened": 0,
			"offUpdates": hub.subscribe(`preview.hmr.${String(port)}`, (message) => {
				for (const element of servers.get(port)?.windows ?? []) {
					const page = element.querySelector("iframe")?.contentWindow;

					if (page !== null && page !== undefined) {
						for (const target of framesUnder(page)) {
							target.postMessage(message, "*");
						}
					}
				}
			})
		});
		open(port);
	});

	// A service asked for that's up already: a window onto it, open and in front of the rest.
	hub.subscribe("preview.show", (data) => {
		const { port } = data as { "port": number };
		const windows = servers.get(port)?.windows ?? new Set<HTMLElement>();
		const shown = used.findLast((element) => windows.has(element)) ?? open(port);

		if (shown !== undefined) {
			const front = Math.max(...used.map((element) => Number(getComputedStyle(element).zIndex)));

			shown.removeAttribute("collapsed");
			shown.style.setProperty("--app-window-z", String(front + 1));
			useWindow(shown);
		}
	});

	// What the app wants to reach, asked in the window you used last: none open and showing, in a page that's showing, is nobody
	// watching (extensions/bridge/preview-gate.ts answers for them).
	serve(hub, "preview.ask", async (args) => {
		const ask = args as PreviewAsk;
		const windows = servers.get(ask.port)?.windows;
		const shown = used.findLast((element) => windows?.has(element) === true && !element.hasAttribute("collapsed"));

		return shown === undefined || document.visibilityState !== "visible" ? { "unwatched": true } : { "answer": await askInWindow(shown, ask) };
	});

	hub.subscribe("preview.close", (data) => {
		const { port } = data as { "port": number };
		const server = servers.get(port);

		if (server !== undefined) {
			server.offUpdates();

			for (const element of server.windows) {
				undock.get(element)?.();
				element.remove();
				used.splice(used.indexOf(element) >>> 0, 1);
			}

			servers.delete(port);
			retarget();
		}
	});

	/** The window each test's page has, while its test runs; and which of them it opened. */
	const claimed = new Map<string, HTMLElement>();
	const openedForPage = new Set<HTMLElement>();

	/** `page`'s window: the one it has; else going somewhere opens it one of its own, and anything else takes the one you've
	 *  used last that no other page has. */
	const windowOf = (page: string, opening: boolean): HTMLElement | undefined => {
		const known = claimed.get(page);

		if (known?.isConnected === true) {
			return known;
		}

		const others = new Set(claimed.values());
		let found: HTMLElement | undefined;

		if (opening) {
			servers.set(NO_SERVER, servers.get(NO_SERVER) ?? { "url": "about:blank", "windows": new Set(), "opened": 0, "offUpdates": () => undefined });
			found = open(NO_SERVER);

			if (found !== undefined) {
				openedForPage.add(found);
			}
		} else {
			found = used.filter((element) => !others.has(element)).at(-1);
		}

		if (found !== undefined) {
			claimed.set(page, found);
		}

		return found;
	};

	serve(hub, "playwright.run", async (args) => {
		const { call, "args": given = [], "page": asking = "" } = args as PlaywrightCall;

		if (call === "release") {
			const element = claimed.get(asking);

			claimed.delete(asking);

			// (nor is one closed while its counts are to be read, COVERAGE=1's: the harness closes it, having read them)
			if (element !== undefined && openedForPage.delete(element) && given[0] !== true && !("__evidence" in globalThis)) {
				undock.get(element)?.();
				element.remove();
				used.splice(used.indexOf(element) >>> 0, 1);
				servers.get(NO_SERVER)?.windows.delete(element);
				retarget();
			}

			return undefined;
		}

		const page = windowOf(asking, call === "goto")?.querySelector("iframe")?.contentWindow;

		if (page === null || page === undefined) {
			if (call === "run") {
				return { "done": false, "why": "no preview window is open" };
			}

			throw new Error("no preview window is open");
		}

		// (dynamically: only a test file that drives a page needs it)
		const { windowDriver } = await import("@brianjenkins94/playwright");

		return (windowDriver(page)[call] as (...rest: unknown[]) => Promise<unknown>)(...given);
	});
}

export const previewWindows: ShellFeature = {
	"start": ({ hub }) => {
		install(hub);
	}
};
