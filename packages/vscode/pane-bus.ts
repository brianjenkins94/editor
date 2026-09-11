/**
 * Pane bus — the cross-window transport that lets a pane survive being popped out.
 *
 * A "pane" is a workbench (and later a preview) running in its own window: normally the in-page iframe,
 * but the same document can be reloaded into a standalone popped-out tab. The trick that makes persistence
 * work (lifted from games/packages/harness/client.tsx) is IDENTITY-FROM-URL: the pane's id travels in its
 * URL (`?pane=<id>`), so a pane reloaded into a popped-out tab still knows who it is and re-announces under
 * the same id. The host keeps a per-id record and, crucially, updates that pane's CURRENT window to
 * whichever window last messaged it (`event.source`) — so after a popout the host routes to the popped
 * window; before one, to the in-page iframe. It NEVER recreates the iframe (that would reload the pane and
 * drop its state); it just retargets.
 *
 * This module is a dumb envelope transport. The workbench's own handshake (ready → init, save, online)
 * rides on top as the `payload` — see vscode.tsx (host) and workbench-entry.tsx (pane). Every pane→host
 * message doubles as an announce: it carries the pane id, so the host learns the pane's live window from
 * it, which is why re-sending "ready" after a reload/popout is all it takes to re-pair.
 */

/** Envelope wrapping every host ⇄ pane message with the pane's stable id. The `__pane` key is a
 *  deliberately namespaced wire discriminator (not camelCase) so it can't collide with a payload field. */
interface PaneEnvelope {
	// eslint-disable-next-line ts/naming-convention
	"__pane": string;
	"payload": unknown;
}

function isEnvelope(data: unknown): data is PaneEnvelope {
	return typeof data === "object" && data !== null && typeof (data as PaneEnvelope).__pane === "string";
}

// ── Host side ────────────────────────────────────────────────────────────────────

export interface PaneBusHost {
	/** Record the in-page iframe for a pane id (the default target until the pane announces a window). */
	"register": (id: string, iframe: HTMLIFrameElement) => void;
	/** Send a payload to a pane, routed to its current window (popped-out window if any, else the iframe). */
	"post": (id: string, payload: unknown) => void;
	/** Handle payloads arriving from any pane. The pane's live window is already tracked before this runs. */
	"on": (handler: (id: string, payload: unknown) => void) => void;
	/** The pane's current window (popped-out window if it announced one, else the iframe's contentWindow). */
	"windowFor": (id: string) => Window | undefined;
}

export function createPaneBusHost(): PaneBusHost {
	const panes = new Map<string, { "iframe"?: HTMLIFrameElement; "win"?: Window }>();
	const handlers: ((id: string, payload: unknown) => void)[] = [];

	const entryFor = (id: string): { "iframe"?: HTMLIFrameElement; "win"?: Window } => {
		let entry = panes.get(id);

		if (entry === undefined) {
			entry = {};
			panes.set(id, entry);
		}

		return entry;
	};

	window.addEventListener("message", (event) => {
		if (!isEnvelope(event.data)) {
			return;
		}

		// Track the pane's live window: whoever last messaged us under this id is where replies now go.
		// This is what makes a popped-out pane keep receiving host messages without recreating anything.
		entryFor(event.data.__pane).win = event.source as Window;

		for (const handler of handlers) {
			handler(event.data.__pane, event.data.payload);
		}
	});

	return {
		"register": (id, iframe) => { entryFor(id).iframe = iframe; },
		"post": (id, payload) => {
			const entry = panes.get(id);
			const target = entry?.win ?? entry?.iframe?.contentWindow ?? undefined;

			target?.postMessage({ "__pane": id, "payload": payload } satisfies PaneEnvelope, "*");
		},
		"on": (handler) => { handlers.push(handler); },
		"windowFor": (id) => {
			const entry = panes.get(id);

			return entry?.win ?? entry?.iframe?.contentWindow ?? undefined;
		}
	};
}

// ── Pane side ────────────────────────────────────────────────────────────────────

export interface PaneBus {
	/** This pane's stable id, read from `?pane=` in its own URL (so it survives a popout reload). */
	"id": string;
	/** Send a payload to the host page. */
	"post": (payload: unknown) => void;
	/** Handle payloads from the host. */
	"on": (handler: (payload: unknown) => void) => void;
}

/**
 * Connect this document as a pane. Identity comes from `?pane=<id>` in the URL (falling back to
 * `fallbackId`), and the host is `window.opener` when popped out, else `window.parent`. Every `post`
 * carries the pane id, so it doubles as an announce that (re)registers this window with the host.
 */
export function connectAsPane(fallbackId = "pane"): PaneBus {
	const id = new URLSearchParams(location.search).get("pane") ?? fallbackId;
	const host = window.opener ?? window.parent;
	const handlers: ((payload: unknown) => void)[] = [];

	window.addEventListener("message", (event) => {
		if (event.source !== host || !isEnvelope(event.data) || event.data.__pane !== id) {
			return;
		}

		for (const handler of handlers) {
			handler(event.data.payload);
		}
	});

	return {
		"id": id,
		"post": (payload) => { host.postMessage({ "__pane": id, "payload": payload } satisfies PaneEnvelope, "*"); },
		"on": (handler) => { handlers.push(handler); }
	};
}
