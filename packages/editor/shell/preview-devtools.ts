import type { Hub } from "@brianjenkins94/hub";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import { logger } from "@brianjenkins94/util/logger";
import { previewDevtools } from "theme/styles/shell";

const log = logger({ "source": "shell" });

const CHOBITSU_URL = "https://cdn.jsdelivr.net/npm/chobitsu@1.8.6/dist/chobitsu.js";
const FRONTEND_URL = "https://cdn.jsdelivr.net/npm/chii@1.15.5/public/front_end";

export const PREVIEW_CDP = "preview.cdp";
export const PREVIEW_CDP_EVENT = "preview.cdp.event.";

interface Chobitsu {
	"setOnMessage": (onMessage: (message: string) => void) => void;
	"sendRawMessage": (message: string) => void;
}

interface PageSession {
	"chobitsu": Chobitsu;
	"pending": Map<string, (reply: string) => void>;
}

async function chobitsuIn(page: Window): Promise<Chobitsu> {
	const existing = (page as Window & { "chobitsu"?: Chobitsu }).chobitsu;

	if (existing !== undefined) {
		return existing;
	}

	await log.span("editor.shell.preview-devtools.load", { "path": page.location.pathname }, async () => new Promise<void>((resolve, reject) => {
		const script = page.document.createElement("script");

		script.src = CHOBITSU_URL;
		script.addEventListener("load", () => {
			resolve();
		});
		script.addEventListener("error", () => {
			reject(new Error("couldn't load chobitsu into the preview"));
		});
		page.document.head.append(script);
	}));

	const loaded = (page as Window & { "chobitsu"?: Chobitsu }).chobitsu;

	if (loaded === undefined) {
		throw new Error("chobitsu loaded but didn't define itself");
	}

	return loaded;
}

export function installPreviewCdp(hub: Hub, frameOf: (window: { "key"?: string; "port"?: number }) => { "key": string; "frame": HTMLIFrameElement } | undefined): void {
	const sessions = new WeakMap<Window, Promise<PageSession>>();
	let nextId = 0;

	const sessionFor = (key: string, page: Window): Promise<PageSession> => {
		const existing = sessions.get(page);

		if (existing !== undefined) {
			return existing;
		}

		const session = chobitsuIn(page).then((chobitsu) => {
			const pending = new Map<string, (reply: string) => void>();

			chobitsu.setOnMessage((message) => {
				const { id } = JSON.parse(message) as { "id"?: unknown };

				if (id === undefined) {
					hub.publish(PREVIEW_CDP_EVENT + key, message);
				} else if (typeof id === "string") {
					pending.get(id)?.(message);
					pending.delete(id);
				}
			});

			return { "chobitsu": chobitsu, "pending": pending };
		});

		session.catch(() => {
			sessions.delete(page);
		}); // didn't load: the next command tries again
		sessions.set(page, session);

		return session;
	};

	serve(hub, PREVIEW_CDP, async (args) => {
		const { "window": named, port, message } = (args ?? {}) as { "window"?: unknown; "port"?: unknown; "message"?: unknown };

		if (typeof message !== "string") {
			throw new Error("preview.cdp takes { message, and window or port }");
		}

		const asked = {
			...typeof named === "string" ? { "key": named } : {},
			...typeof port === "number" ? { "port": port } : {}
		};
		const found = frameOf(asked);
		const page = found?.frame.contentWindow;

		if (found === undefined || page === undefined || page === null) {
			throw new Error(`no preview window ${asked.key ?? (asked.port === undefined ? "is open" : `on :${String(asked.port)}`)}`);
		}

		const { key } = found;

		const { chobitsu, pending } = await sessionFor(key, page);
		const command = JSON.parse(message) as Record<string, unknown>;
		const own = "hub:" + String(nextId += 1);

		return new Promise<string>((resolve) => {
			pending.set(own, (reply) => {
				resolve(JSON.stringify({ ...JSON.parse(reply) as Record<string, unknown>, "id": command.id }));
			});
			chobitsu.sendRawMessage(JSON.stringify({ ...command, "id": own }));
		});
	});
}

function frontendUrl(): string {
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
	"element": HTMLElement;
	"dispose": () => void;
}

export function openDevtoolsPanel(hub: Hub, key: string, preview: HTMLIFrameElement): DevtoolsPanel {
	const rpc = createRpcClient(hub);
	const element = document.createElement("div");
	const frame = document.createElement("iframe");
	let blobUrl: string | undefined;
	let generation = 0;

	element.className = previewDevtools();
	frame.title = "DevTools";
	frame.setAttribute("sandbox", "allow-scripts");
	element.append(frame);

	const toFrontend = (message: string): void => {
		frame.contentWindow?.postMessage(message, "*");
	}; // an opaque origin has no name to target

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

		rpc.request(PREVIEW_CDP, { "window": key, "message": event.data }, { "timeoutMs": 30000 }).then(
			(reply) => {
				if (sentFor === generation && typeof reply === "string") {
					toFrontend(reply);
				}
			},
			(error: unknown) => {
				log.warn("DevTools' command went unanswered", { "window": key, "error": String(error) });
			}
		);
	};

	const offEvents = hub.subscribe(PREVIEW_CDP_EVENT + key, (message) => {
		if (typeof message === "string") {
			toFrontend(message);
		}
	});

	globalThis.addEventListener("message", onMessage);
	preview.addEventListener("load", start);
	start();

	return {
		"element": element,
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
