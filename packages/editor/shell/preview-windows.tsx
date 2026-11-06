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
 * And in-editor Playwright's way onto a page (`playwright.run`, a test file's in the debugger: packages/playwright): each
 * test's page has a window of its own while it runs, so tests can run at once: the one it opens by going somewhere, or else
 * the one you've used last that no other page has. A preview's frame is same-origin with the shell, so its DOM is right here.
 */
import type { PlaywrightCall } from "@brianjenkins94/editor-api/runtime";
import type { Hub } from "@brianjenkins94/hub";
import type { ShellFeature } from "./feature";
import { appWindow } from "@brianjenkins94/app-window";
import { serve } from "@brianjenkins94/hub";
import { AppWindow } from "lucide";
import { render } from "preact";
import { previewFrame } from "theme/styles/shell";
import { Icon } from "./icon";
import { askInWindow, type PreviewAsk } from "./preview-ask";
import "theme/components/button";

/** How far each further window of a server opens from the one before it, so none opens exactly over another. */
const CASCADE = 32;
const FIRST_AT = 96;
const WIDTH = 720;
const HEIGHT = 480;
const FEWEST_PLACES = 4;

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

/** A window's frame and every frame its app nests: each has a client of its own, which acts only on what it loaded. */
function framesUnder(root: Window): Window[] {
	return [root, ...Array.from({ "length": root.frames.length }, (_, index) => framesUnder(root.frames[index]!)).flat()];
}

function install(hub: Hub): void {
	const servers = new Map<number, Server>();
	/** The windows, the one last used last. */
	const used: HTMLElement[] = [];

	const useWindow = (element: HTMLElement): void => {
		used.splice(used.indexOf(element) >>> 0, 1);
		used.push(element);
	};

	const open = (port: number): HTMLElement | undefined => {
		const server = servers.get(port);

		if (server === undefined) {
			return undefined;
		}

		const frame = document.createElement("iframe");
		const another = document.createElement("div");
		const at = cascadeAt(server.opened);

		frame.className = previewFrame();
		frame.title = port === NO_SERVER ? "Preview" : `Preview :${String(port)}`;
		frame.allow = "cross-origin-isolated";
		frame.src = server.url;
		render(<wa-button appearance="plain" size="small" title="Another window onto this server" aria-label="Another window onto this server" onClick={() => { open(port); }}><Icon node={AppWindow} /></wa-button>, another);

		const element = appWindow({
			"label": port === NO_SERVER ? "Preview" : `Preview :${String(port)}`,
			"closable": true,
			"width": WIDTH,
			"bodyHeight": HEIGHT,
			"headerActions": [another],
			"children": [frame],
			"onClose": () => {
				element.remove();
				used.splice(used.indexOf(element) >>> 0, 1);
				server.windows.delete(element);

				if (server.windows.size === 0 && port !== NO_SERVER) {
					hub.publish("preview.close", { "port": port });
				}
			}
		});

		element.dataset["previewPort"] = String(port);
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
				element.remove();
				used.splice(used.indexOf(element) >>> 0, 1);
			}

			servers.delete(port);
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
				element.remove();
				used.splice(used.indexOf(element) >>> 0, 1);
				servers.get(NO_SERVER)?.windows.delete(element);
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
