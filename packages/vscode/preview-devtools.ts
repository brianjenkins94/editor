/**
 * Chrome DevTools for the app previews, over the hub.
 *
 * Two halves:
 *  - the CDP endpoint (`installPreviewCdp`): the shell serves `preview.cdp` — `{ port, message }`, one raw Chrome
 *    DevTools Protocol command for that preview's page, answered with the raw reply — and publishes the page's events
 *    on `preview.cdp.event.<port>`. It reaches the page through chobitsu (a JavaScript implementation of CDP, the engine
 *    under eruda, chii and CodeSandbox's DevTools), which it adds to the page on first use: the preview is same origin
 *    and unsandboxed (see ARCHITECTURE.md), so nothing is injected until something asks. Each caller's ids are swapped
 *    for the endpoint's own, so several clients can share a page.
 *  - the panel (`openDevtoolsPanel`): Chrome's own DevTools frontend, docked under the preview — one client of that
 *    endpoint. It's chii's CDN mode: a tiny host page, made here as a blob: URL, loads the frontend's modules from
 *    jsDelivr (CORS + CORP, so it loads under COEP without a proxy). Its "embedded" mode speaks CDP to its parent by
 *    postMessage. The frame is sandboxed (`allow-scripts` only), so the frontend — 12 MB of someone else's code —
 *    runs in an opaque origin: it can't reach this page, the editor's storage or the hub, only post CDP to us (its web
 *    storage, which throws there, is kept in memory). That bounds what it can touch directly, not what CDP lets it
 *    ask for: Runtime.evaluate runs in the preview's page, which is no boundary (see ARCHITECTURE.md).
 *
 * What chobitsu can't do: pause. Its Debugger domain lists scripts and their source, but a page can't stop itself at a
 * breakpoint — Console, Elements, Network, Application and evaluation work; stepping is the tsval debugger's.
 */
import type { Hub } from "@brianjenkins94/hub";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { css } from "./theme";

const CHOBITSU_URL = "https://cdn.jsdelivr.net/npm/chobitsu@1.8.6/dist/chobitsu.js";
const FRONTEND_URL = "https://cdn.jsdelivr.net/npm/chii@1.15.5/public/front_end";

/** RPC: `{ port, message }` → the raw reply. */
export const PREVIEW_CDP = "preview.cdp";
/** Event subject prefix: `preview.cdp.event.<port>` carries each raw event of that preview's page. */
export const PREVIEW_CDP_EVENT = "preview.cdp.event.";

const panelClass = css({ "flex": "0 0 45%", "minHeight": 0, "borderBlockStart": "1px solid var(--wa-color-surface-border)", "& > iframe": { "display": "block", "border": 0, "width": "100%", "height": "100%" } });

interface Chobitsu {
	"setOnMessage": (onMessage: (message: string) => void) => void;
	"sendRawMessage": (message: string) => void;
}

interface PageSession {
	"chobitsu": Chobitsu;
	/** Replies awaited, by the endpoint's own id. */
	"pending": Map<string, (reply: string) => void>;
}

/** chobitsu in `page`'s realm, added on first use: the page's own script, so it sees that page's DOM, console and
 *  network. */
async function chobitsuIn(page: Window): Promise<Chobitsu> {
	const existing = (page as Window & { "chobitsu"?: Chobitsu }).chobitsu;

	if (existing !== undefined) {
		return existing;
	}

	await new Promise<void>((resolve, reject) => {
		const script = page.document.createElement("script");

		script.src = CHOBITSU_URL;
		script.addEventListener("load", () => { resolve(); });
		script.addEventListener("error", () => { reject(new Error("couldn't load chobitsu into the preview")); });
		page.document.head.append(script);
	});

	const loaded = (page as Window & { "chobitsu"?: Chobitsu }).chobitsu;

	if (loaded === undefined) {
		throw new Error("chobitsu loaded but didn't define itself");
	}

	return loaded;
}

/** Serve `preview.cdp` for the preview on each port — `frameOf` finds its iframe. A page is a session: a reload is a new
 *  page, which gets its own chobitsu on the next command. */
export function installPreviewCdp(hub: Hub, frameOf: (port: number) => HTMLIFrameElement | undefined): void {
	const sessions = new WeakMap<Window, Promise<PageSession>>();
	let nextId = 0;

	const sessionFor = (port: number, page: Window): Promise<PageSession> => {
		const existing = sessions.get(page);

		if (existing !== undefined) {
			return existing;
		}

		const session = chobitsuIn(page).then((chobitsu) => {
			const pending = new Map<string, (reply: string) => void>();

			chobitsu.setOnMessage((message) => {
				const { id } = JSON.parse(message) as { "id"?: unknown };

				if (id === undefined) {
					hub.publish(PREVIEW_CDP_EVENT + port, message);
				} else if (typeof id === "string") {
					pending.get(id)?.(message);
					pending.delete(id);
				}
			});

			return { "chobitsu": chobitsu, "pending": pending };
		});

		session.catch(() => { sessions.delete(page); }); // didn't load: the next command tries again
		sessions.set(page, session);

		return session;
	};

	serve(hub, PREVIEW_CDP, async (args) => {
		const { port, message } = (args ?? {}) as { "port"?: unknown; "message"?: unknown };

		if (typeof port !== "number" || typeof message !== "string") {
			throw new Error("preview.cdp takes { port, message }");
		}

		const page = frameOf(port)?.contentWindow;

		if (page === undefined || page === null) {
			throw new Error("no preview page on port " + port);
		}

		const { chobitsu, pending } = await sessionFor(port, page);
		const command = JSON.parse(message) as Record<string, unknown>;
		const own = "hub:" + String(nextId += 1);

		return new Promise<string>((resolve) => {
			pending.set(own, (reply) => { resolve(JSON.stringify({ ...JSON.parse(reply) as Record<string, unknown>, "id": command.id })); });
			chobitsu.sendRawMessage(JSON.stringify({ ...command, "id": own }));
		});
	});
}

/** chii's CDN-mode host page, as a blob: URL (so it has this page's origin, and so its COEP). */
function frontendUrl(): string {
	// eslint-disable-next-line webawesome/no-html-in-strings -- the frontend's own host document (a blob:), not app chrome
	const html = `<!DOCTYPE html>
<html lang="en">
<meta charset="utf-8">
<title>DevTools</title>
<style>@media (prefers-color-scheme: dark) { body { background-color: rgb(41 42 45); } }</style>
<meta name="referrer" content="no-referrer">
<script>
// Sandboxed (an opaque origin), web storage throws on access: DevTools keeps its settings there, so give it memory.
for (const name of ["localStorage", "sessionStorage"]) {
	const items = new Map();
	const storage = {
		get length() { return items.size; },
		key: (index) => [...items.keys()][index] ?? null,
		getItem: (key) => (items.has(String(key)) ? items.get(String(key)) : null),
		setItem: (key, value) => { items.set(String(key), String(value)); },
		removeItem: (key) => { items.delete(String(key)); },
		clear: () => { items.clear(); }
	};
	Object.defineProperty(window, name, { value: storage, configurable: true });
}
</script>
<script type="module" src="${FRONTEND_URL}/entrypoints/chii_app/chii_app.js"></script>
<body class="undocked" id="-blink-dev-tools">`;

	return URL.createObjectURL(new Blob([html], { "type": "text/html" }));
}

export interface DevtoolsPanel {
	/** The panel to dock under the preview. */
	"element": HTMLElement;
	/** The frontend's iframe (so the architecture probe can name what it posts). */
	"frame": HTMLIFrameElement;
	"dispose": () => void;
}

/** Chrome's DevTools frontend for the preview on `port`, talking to it through `preview.cdp`. A new page in the preview
 *  (a reload) starts the frontend over: it holds the old page's state. */
export function openDevtoolsPanel(hub: Hub, port: number, preview: HTMLIFrameElement): DevtoolsPanel {
	const rpc = createRpcClient(hub);
	const element = document.createElement("div");
	const frame = document.createElement("iframe");
	let blobUrl: string | undefined;
	// Which frontend a reply belongs to: one sent before a restart is for a frontend that's gone, whose ids the new one
	// reuses.
	let generation = 0;

	element.className = panelClass();
	frame.title = "DevTools";
	// An opaque origin: whatever the frontend runs can't reach this page, its storage or the hub — only post CDP to us.
	frame.setAttribute("sandbox", "allow-scripts");
	element.append(frame);

	const toFrontend = (message: string): void => { frame.contentWindow?.postMessage(message, "*"); }; // an opaque origin has no name to target

	const start = (): void => {
		generation += 1;

		if (blobUrl !== undefined) {
			URL.revokeObjectURL(blobUrl);
		}

		blobUrl = frontendUrl();
		frame.src = blobUrl + "#?embedded=" + encodeURIComponent(location.origin);
	};

	const onMessage = (event: MessageEvent): void => {
		if (event.source !== frame.contentWindow || event.origin !== "null" || typeof event.data !== "string") {
			return;
		}

		const sentFor = generation;

		rpc.request(PREVIEW_CDP, { "port": port, "message": event.data }, { "timeoutMs": 30000 }).then(
			(reply) => {
				if (sentFor === generation && typeof reply === "string") {
					toFrontend(reply);
				}
			},
			(error: unknown) => { console.warn("[devtools]", error); }
		);
	};

	const offEvents = hub.subscribe(PREVIEW_CDP_EVENT + port, (message) => {
		if (typeof message === "string") {
			toFrontend(message);
		}
	});

	globalThis.addEventListener("message", onMessage);
	preview.addEventListener("load", start);
	start();

	return {
		"element": element,
		"frame": frame,
		"dispose": () => {
			offEvents();
			globalThis.removeEventListener("message", onMessage);
			preview.removeEventListener("load", start);

			if (blobUrl !== undefined) {
				URL.revokeObjectURL(blobUrl);
			}

			element.remove();
		}
	};
}
