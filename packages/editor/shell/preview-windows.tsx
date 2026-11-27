/** @jsxImportSource preact */
import type { ModuleEvidence } from "@brianjenkins94/editor-api/recorded";
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
import { askRealms, driving, inFull, keepEvidence } from "./own-evidence";
import { createPreviewProfiler, installPreviewProfiler, PROFILE_MS } from "./preview-profile";
import "theme/components/button";

const log = logger({ "source": "shell" });

function distinct(lines: [number, number][]): [number, number][] {
	const seen = new Map(lines.map(([from, to]) => [`${String(from)}-${String(to)}`, [from, to] as [number, number]]));

	return [...seen.values()].sort(([one, oneEnd], [other, otherEnd]) => one - other || oneEnd - otherEnd);
}

const CASCADE = 32;
const FIRST_AT = 96;
const WIDTH = 720;
const HEIGHT = 480;
const FEWEST_PLACES = 4;
const DEVTOOLS_HEIGHT = 340;

function cascadeAt(opened: number): number {
	const room = Math.min(window.innerWidth - WIDTH, window.innerHeight - HEIGHT - CASCADE) - FIRST_AT;

	return FIRST_AT + (opened % Math.max(FEWEST_PLACES, Math.floor(room / CASCADE) + 1)) * CASCADE;
}

interface Server { "url": string; "windows": Set<HTMLElement>; "opened": number; "offUpdates": () => void }

const NO_SERVER = 0;

interface DebugState { "active": boolean; "type": string; "paused": boolean; "port"?: number }

const debugging = createStore<{ "state": DebugState; "window"?: string }>({ "state": { "active": false, "type": "", "paused": false } });

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
					void profile().catch(() => undefined).finally(() => { setProfiling(false); });
				}}
			>
				<Icon node={Gauge} />
			</wa-button>
			<wa-button appearance={docked ? "filled" : "plain"} size="small" title={docked ? "Close DevTools" : "DevTools"} aria-label={docked ? "Close DevTools" : "DevTools"} onClick={() => { setDocked(devtools()); }}><Icon node={Bug} /></wa-button>
		</>
	);
}

function framesUnder(root: Window): Window[] {
	return [root, ...Array.from({ "length": root.frames.length }, (_, index) => framesUnder(root.frames[index]!)).flat()];
}

function install(hub: Hub): void {
	const servers = new Map<number, Server>();
	const used: HTMLElement[] = [];
	const undock = new WeakMap<HTMLElement, () => void>();
	const profile = createPreviewProfiler(hub);

	const profiled = (element: HTMLElement): { "key": string; "port": number; "page": Window } | undefined => {
		const page = element.querySelector("iframe")?.contentWindow;

		return page === null || page === undefined ? undefined : { "key": element.dataset["previewWindow"]!, "port": Number(element.dataset["previewPort"]), "page": page };
	};

	const windowAt = ({ key, port }: { "key"?: string; "port"?: number }): HTMLElement | undefined => (key === undefined
		? used.findLast((each) => port === undefined || servers.get(port)?.windows.has(each) === true)
		: used.find((each) => each.dataset["previewWindow"] === key));

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

	hub.subscribe("debug.state", (data) => {
		debugging.set({ "state": data as DebugState });
		retarget();
	});
	hub.publish("debug.state.ask", {});

	installPreviewCdp(hub, (asked) => {
		const element = windowAt(asked);
		const frame = element?.querySelector("iframe");

		return element === undefined || frame === null || frame === undefined ? undefined : { "key": element.dataset["previewWindow"]!, "frame": frame };
	});

	installPreviewProfiler(hub, profile, (asked) => {
		const element = windowAt(asked);

		return element === undefined ? undefined : profiled(element);
	});

	addEventListener("message", (event: MessageEvent) => {
		const { channel, port, page, modules, packages } = (event.data ?? {}) as { "channel"?: unknown; "port"?: unknown; "page"?: unknown; "modules"?: unknown; "packages"?: unknown };

		if (channel === "editor-evidence" && event.origin === location.origin && typeof port === "number") {
			hub.publish("evidence.preview", { "window": `preview:${String(port)}`, "page": page, "modules": modules, "packages": packages });
		}
	});

	addEventListener("message", (event: MessageEvent) => {
		const { channel, port, stops } = (event.data ?? {}) as { "channel"?: unknown; "port"?: unknown; "stops"?: unknown };

		if (channel === "editor-stops" && event.origin === location.origin && typeof port === "number" && Array.isArray(stops)) {
			hub.publish("stops.preview", { "port": port, "stops": stops });
		}
	});

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

	const claimed = new Map<string, HTMLElement>();
	const openedForPage = new Set<HTMLElement>();

	const counting = "__evidence" in globalThis;
	const realmsBefore = new Map<string, Set<string>>();
	const ranSoFar = new Map<string, Map<string, [number, number][]>>();
	const drivenSoFar = new Map<string, Map<string, ModuleEvidence[]>>();
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
				ran.set(file, distinct([...ran.get(file) ?? [], ...lines]));
			}
		}

		ranSoFar.set(page, ran);

		if (inFull() && realms.length > 0) {
			const driven = drivenSoFar.get(page) ?? new Map<string, ModuleEvidence[]>();

			for (const { realm, modules } of await askRealms({ "ask": "full", "realms": realms })) {
				driven.set(realm, modules ?? []);
			}

			drivenSoFar.set(page, driven);
		}

		span.end({ "count": realms.length, "answered": answers.length, "files": ran.size });
	});

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

	const schemes = new Map<string, string>();
	const emulateScheme = (frame: HTMLIFrameElement, scheme: string): void => {
		// eslint-disable-next-line webawesome/no-inline-styles -- a Playwright page's colorScheme: the frame's color-scheme is what its prefers-color-scheme follows, not themeable chrome
		frame.style.colorScheme = scheme;
	};

	serve(hub, "playwright.run", async (args) => {
		const { call, "args": given = [], "page": asking = "" } = args as PlaywrightCall;

		if (call === "release") {
			await collect(asking);

			const reach = ranSoFar.get(asking);
			const driven = [...drivenSoFar.get(asking) ?? []].map(([realm, modules]) => ({ "realm": realm, "modules": modules }));
			const element = claimed.get(asking);

			realmsBefore.delete(asking);
			ranSoFar.delete(asking);
			drivenSoFar.delete(asking);

			driving.delete(asking);

			if (driven.length > 0) {
				await keepEvidence(hub, "The editor, driven by a test", driven).catch((error: unknown) => {
					log.warn("the driven editor's evidence wasn't kept", { "error": error instanceof Error ? error.message : String(error) });
				});
			}
			schemes.delete(asking);

			claimed.delete(asking);

			if (element !== undefined && openedForPage.delete(element) && given[0] !== true) {
				await (globalThis as { "__countedBeforeClosing"?: () => Promise<void> }).__countedBeforeClosing?.();
				undock.get(element)?.();
				element.remove();
				used.splice(used.indexOf(element) >>> 0, 1);
				servers.get(NO_SERVER)?.windows.delete(element);
				retarget();
			}

			return reach === undefined ? undefined : { "reach": Object.fromEntries(reach) };
		}

		if (call === "fetch") {
			const { fetched, requestInit } = await import("@brianjenkins94/playwright");
			const [url, init] = given as [string, Parameters<typeof requestInit>[0]];

			return fetched(await fetch(url, requestInit(init)));
		}

		if (counting && call === "goto") {
			if (realmsBefore.has(asking)) {
				await collect(asking);
			} else {
				driving.add(asking);
				realmsBefore.set(asking, new Set((await askRealms({ "ask": "realms" })).map(({ realm }) => realm)));
			}
		}

		if (call === "emulate") {
			const [{ colorScheme }] = given as [{ "colorScheme"?: "light" | "dark" | null }];

			schemes.set(asking, colorScheme ?? "");

			const frame = claimed.get(asking)?.querySelector("iframe");

			if (frame !== null && frame !== undefined) {
				emulateScheme(frame, colorScheme ?? "");
			}

			return undefined;
		}

		const frame = windowOf(asking, call === "goto")?.querySelector("iframe");

		if (frame !== null && frame !== undefined && schemes.has(asking)) {
			emulateScheme(frame, schemes.get(asking) ?? "");
		}

		const page = frame?.contentWindow;

		if (page === null || page === undefined) {
			if (call === "run") {
				return { "done": false, "why": "no preview window is open" };
			}

			throw new Error("no preview window is open");
		}

		const { windowDriver } = await import("@brianjenkins94/playwright");

		return (windowDriver(page)[call] as (...rest: unknown[]) => Promise<unknown>)(...given);
	});
}

export const previewWindows: ShellFeature = {
	"start": ({ hub }) => {
		install(hub);
	}
};
