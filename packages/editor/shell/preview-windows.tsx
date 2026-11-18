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
 * With the dev server counting (COVERAGE=1), what the editor in a test's window ran — every realm of it — goes back with
 * the page as it's let go, the test's reach.
 */
import type { Leaves } from "@brianjenkins94/editor-api";
import type { PlaywrightCall } from "@brianjenkins94/editor-api/runtime";
import type { Hub } from "@brianjenkins94/hub";
import type { ShellFeature } from "./feature";
import type { DevtoolsPanel } from "./preview-devtools";
import { appWindow } from "@brianjenkins94/app-window";
import { serve } from "@brianjenkins94/hub";
import { logger } from "@brianjenkins94/util/logger";
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

const log = logger({ "source": "shell" });

/** Where the coverage build's realms answer (build/coverage.ts, COVERAGE=1): every instrumented realm on the origin,
 *  frames and workers alike. */
const COVERAGE_CHANNEL = "editor.coverage";

/** How long a question there waits for answers: a realm busy for longer (a worker blocked) isn't heard. */
const ASK_MS = 1000;
/** The channel an editor says on what it was left with (workbench/effects.ts), and how long one is waited for. */
const EFFECTS_CHANNEL = "editor.effects";
const LEAVES_MS = 2000;
/** How long a shared editor's reset may take: what it closes and stops, and the workspace written back. */
const RESET_MS = 60_000;
/** How many tests a shared editor serves before it's let go: its renderer grew ~250 MB a test on 2026-11-17 (3.8 GB to 6.4 over
 *  ten specs, a crash near 9 at the eleventh), what runs leave behind not all given back by a reset. */
const SHARED_USES = 4;
/** How long a shared editor waits for another test before it's let go. */
const IDLE_MS = 15_000;
/** A shared editor's first reset waits for it to come up too (workbench/effects.ts waits up to 2 minutes for that). */
const FIRST_RESET_MS = 180_000;
/** How often a reset is asked again until it's heard. */
const ASK_AGAIN_MS = 1000;

/** Each instrumented realm's answer to `ask` on COVERAGE_CHANNEL, within ASK_MS: its id, and what it ran when asked. */
async function askRealms(ask: Record<string, unknown>): Promise<{ "realm": string; "ran"?: Record<string, [number, number][]> }[]> {
	const channel = new BroadcastChannel(COVERAGE_CHANNEL);
	const nonce = crypto.randomUUID();
	const answers: { "realm": string; "ran"?: Record<string, [number, number][]> }[] = [];

	channel.addEventListener("message", ({ data }: MessageEvent<{ "answer"?: string; "realm": string; "ran"?: Record<string, [number, number][]> }>) => {
		if (data.answer === nonce) {
			answers.push(data);
		}
	});
	channel.postMessage({ ...ask, "nonce": nonce });
	await new Promise((resolve) => {
		setTimeout(resolve, ASK_MS);
	});
	channel.close();

	return answers;
}

/** What the editor in `element`'s window was left with (workbench/effects.ts), asked by the instance in its address: an
 *  editor that answers once, or none (a page that isn't an editor, or one gone). */
async function leavesOf(element: HTMLElement | undefined): Promise<Leaves | undefined> {
	let named: string | null | undefined;

	try {
		named = new URLSearchParams(element?.querySelector("iframe")?.contentWindow?.location.search ?? "").get("instance");
	} catch {
		return undefined; // (another origin's page)
	}

	if (named === null || named === undefined) {
		return undefined;
	}

	const channel = new BroadcastChannel(EFFECTS_CHANNEL);
	const nonce = crypto.randomUUID();

	try {
		return await new Promise<Leaves | undefined>((resolve) => {
			channel.addEventListener("message", ({ data }: MessageEvent<{ "answer"?: string; "leaves"?: Leaves }>) => {
				if (data.answer === nonce) {
					resolve(data.leaves);
				}
			});
			channel.postMessage({ "ask": "leaves", "instance": named, "nonce": nonce });
			setTimeout(() => { resolve(undefined); }, LEAVES_MS);
		});
	} finally {
		channel.close();
	}
}

/** Whether `url` asks for a shared editor (`?shared`): test/in-editor/editor.mjs's `openEditor`. */
function sharedAddress(url: string): boolean {
	return new URL(url, location.href).searchParams.has("shared");
}

/** The files a test's address seeds (`seed`: base64 of their JSON, by path). */
function seedOf(url: string): Record<string, string> {
	const seed = new URL(url, location.href).searchParams.get("seed");

	return seed === null ? {} : JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(seed), (character) => character.charCodeAt(0)))) as Record<string, string>;
}

/** A shared editor's first address: booted under a name of its own, empty (its first test's files come as a reset's). */
function bootAddress(url: string): string {
	const address = new URL(url, location.href);

	address.searchParams.delete("shared");
	address.searchParams.set("instance", `shared-${crypto.randomUUID()}`);
	address.searchParams.set("seed", btoa("{}"));

	return `${address.pathname}${address.search}`;
}

/** The shared editor in `element`'s window reset with `seed`'s files (workbench/effects.ts), within RESET_MS: false when it
 *  didn't answer, or couldn't. */
async function resetEditor(element: HTMLElement, seed: Record<string, string>, within = RESET_MS): Promise<boolean> {
	let named: string | null | undefined;

	try {
		named = new URLSearchParams(element.querySelector("iframe")?.contentWindow?.location.search ?? "").get("instance");
	} catch {
		return false;
	}

	if (named === null || named === undefined) {
		return false;
	}

	const channel = new BroadcastChannel(EFFECTS_CHANNEL);
	const nonce = crypto.randomUUID();

	try {
		return await new Promise<boolean>((resolve) => {
			// (asked again until it's heard: an editor just loaded isn't listening yet, and a channel keeps nothing for later)
			const ask = (): void => { channel.postMessage({ "ask": "reset", "instance": named, "nonce": nonce, "seed": seed }); };
			const again = setInterval(ask, ASK_AGAIN_MS);
			const late = setTimeout(() => {
				clearInterval(again);
				resolve(false);
			}, within);
			const done = (reset: boolean): void => {
				clearInterval(again);
				clearTimeout(late);
				resolve(reset);
			};

			channel.addEventListener("message", ({ data }: MessageEvent<{ "answer"?: string; "reset"?: boolean }>) => {
				if (data.answer === nonce) {
					done(data.reset === true);
				}
			});
			ask();
		});
	} finally {
		channel.close();
	}
}

/** Lines `[first, last]` as few ranges as they make. */
function rangesOf(lines: [number, number][]): [number, number][] {
	const ranges: [number, number][] = [];

	for (const [from, to] of lines.toSorted(([one], [other]) => one - other)) {
		const last = ranges.at(-1);

		if (last !== undefined && from <= last[1] + 1) {
			last[1] = Math.max(last[1], to);
		} else {
			ranges.push([from, to]);
		}
	}

	return ranges;
}

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
	/** Shared editors' windows no test has now, each an editor up and reset for the next (NEXT.md item 2, *Specs share an
	 *  editor*): a test going to a `shared` address takes one, rather than booting an editor of its own. */
	const idle: HTMLElement[] = [];

	// With the dev server counting (COVERAGE=1, build/coverage.ts): what a page's window ran is the test's. The realms there
	// were as the page first went somewhere — the editor around it, the service worker — aren't its; every realm since is
	// (its frames and workers), and started counting from nothing. Asked before it goes somewhere again (which replaces
	// them) and as it's let go.
	const counting = "__evidence" in globalThis;
	const realmsBefore = new Map<string, Set<string>>();
	const ranSoFar = new Map<string, Map<string, [number, number][]>>();
	const collect = async (page: string): Promise<void> => log.span("editor.shell.preview-windows.reach", {}, async (span) => {
		const before = realmsBefore.get(page);

		if (before === undefined) {
			return;
		}

		const realms = (await askRealms({ "ask": "realms" })).map(({ realm }) => realm).filter((realm) => !before.has(realm));
		const answers = realms.length === 0 ? [] : await askRealms({ "ask": "ran", "realms": realms });
		const ran = ranSoFar.get(page) ?? new Map<string, [number, number][]>();

		for (const answer of answers) {
			for (const [file, lines] of Object.entries(answer.ran ?? {})) {
				ran.set(file, rangesOf([...ran.get(file) ?? [], ...lines]));
			}
		}

		ranSoFar.set(page, ran);
		span.end({ "count": realms.length, "answered": answers.length, "files": ran.size });
	});

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

		// A test's editor, shared (`?shared&seed=…`): its own window's, or an idle one's, reset with its files — else a window
		// of its own, an editor booted in it under a name of its own, to be shared after.
		if (call === "goto" && typeof given[0] === "string" && sharedAddress(given[0])) {
			const seed = seedOf(given[0]);
			let element = claimed.get(asking) ?? idle.pop();

			while (element !== undefined) {
				claimed.set(asking, element);

				if (element.isConnected && await resetEditor(element, seed)) {
					return undefined;
				}

				// (one that didn't answer isn't used again)
				claimed.delete(asking);
				element.remove();
				element = idle.pop();
			}

			// (booted empty, so what it's reset to is no test's; the test's files then as anyone's are)
			const found = windowOf(asking, true);
			const frame = found?.querySelector("iframe")?.contentWindow;

			if (found === undefined || frame === null || frame === undefined) {
				throw new Error("no preview window could be opened");
			}

			found.dataset["sharedEditor"] = "";

			const { windowDriver } = await import("@brianjenkins94/playwright");

			await windowDriver(frame).goto?.(bootAddress(given[0]));

			if (!await resetEditor(found, seed, FIRST_RESET_MS)) {
				throw new Error("a shared editor didn't come up to be reset");
			}

			return undefined;
		}

		if (call === "release") {
			await collect(asking);

			const reach = ranSoFar.get(asking);
			const element = claimed.get(asking);
			// (what its editor was left with, while it's still there to say: a test after it in the same editor would meet it)
			const leaves = await leavesOf(element);

			realmsBefore.delete(asking);
			ranSoFar.delete(asking);

			claimed.delete(asking);

			// (a shared editor's, its test passed, waits for the next — until it's served SHARED_USES, as an editor doesn't yet give back
			// all a test's work took: NEXT.md item 2; one that failed is left to look at, and not shared again)
			const uses = Number(element?.dataset["sharedEditor"] || 0) + 1;

			if (element?.dataset["sharedEditor"] !== undefined && given[0] !== true && element.isConnected && uses < SHARED_USES) {
				element.dataset["sharedEditor"] = String(uses);
				idle.push(element);
				// (unused for IDLE_MS, it goes: an editor kept for nobody holds what an editor holds)
				setTimeout(() => {
					const at = idle.indexOf(element);

					if (at !== -1) {
						idle.splice(at, 1);
						element.remove();
					}
				}, IDLE_MS);

				return { ...reach === undefined ? {} : { "reach": Object.fromEntries(reach) }, ...leaves === undefined ? {} : { "leaves": leaves } };
			}

			// (nor is one closed while its counts are to be read from outside, COVERAGE=1's harness's: it closes it, having read them)
			if (element !== undefined && openedForPage.delete(element) && given[0] !== true && !("__countedFromOutside" in globalThis)) {
				undock.get(element)?.();
				element.remove();
				used.splice(used.indexOf(element) >>> 0, 1);
				servers.get(NO_SERVER)?.windows.delete(element);
				retarget();
			}

			return { ...reach === undefined ? {} : { "reach": Object.fromEntries(reach) }, ...leaves === undefined ? {} : { "leaves": leaves } };
		}

		// A test's own request: made here, as a client of its origin — no window needed (a stopped server's address is asked
		// too), and not the program's fetch, which the debugger's capability gate decides.
		if (call === "fetch") {
			const { fetched, requestInit } = await import("@brianjenkins94/playwright");
			const [url, init] = given as [string, Parameters<typeof requestInit>[0]];

			return fetched(await fetch(url, requestInit(init)));
		}

		if (counting && call === "goto") {
			if (realmsBefore.has(asking)) {
				await collect(asking);
			} else {
				realmsBefore.set(asking, new Set((await askRealms({ "ask": "realms" })).map(({ realm }) => realm)));
			}
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
