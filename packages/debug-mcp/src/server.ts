/**
 * The debug-mcp as a hub-tree node. It runs a WebSocket server; every page that links in (its rootHub over a
 * `websocketTransport`) becomes a child in the tree, so the debug-mcp is just another hub — the war2 central-hub
 * analog — that happens to live in Node. A single collector leaf subscribes to the reserved `$sys.log.>`
 * observability namespace and files every record into the store. Because routing is interest-based, the pages
 * forward their span/log traffic here precisely because this collector subscribed to it, and nothing else.
 */
import type { Hub, RpcClient } from "@brianjenkins94/hub";
import type { WebSocket } from "ws";

import type { HubLogRecord } from "./store.ts";
import { createHub, createRpcClient, websocketTransport } from "@brianjenkins94/hub";
// From source (not a package dependency): the architecture plane's collector side has no runtime deps.
import type { ArchReport } from "../../observability/src/arch.ts";
import { tagBySubject } from "../../observability/src/log-subject.ts";
import { ARCH_SUBJECT, requestArchSync } from "../../observability/src/arch.ts";
import { ArchitectureStore } from "../../observability/src/arch-store.ts";
import type { TabInfo } from "../../observability/src/tabs.ts";
import { discoverTabs, markOutdated, TAB_HERE } from "../../observability/src/tabs.ts";

import { WebSocketServer } from "ws";
import { RecordStore } from "./store.ts";

/** Reserved observability namespace — must match `@brianjenkins94/observability`'s `LOG_SUBJECT` (kept as its
 *  own constant so this Node collector doesn't pull the browser-oriented observability package). */
const LOG_SUBJECT = "$sys.log";
/** Must match observability's `LOG_BACKLOG`: a page's records from before this link could carry them, as one array. */
const LOG_BACKLOG = "$sys.backlog.log";

/** Origins allowed to connect. Loopback (any port) for local dev, plus the deployed Pages origin — so the
 *  PUBLIC site can still reach a debug-mcp on YOUR machine over `ws://localhost` (loopback is exempt from
 *  mixed-content blocking). The check matters: without it any site you visit could open your debug-mcp and read
 *  your logs, or call the page tools (which include in-page `eval`). Extra origins via `origins`. A connection
 *  with NO Origin header (a non-browser client — tests, the MCP bridge) is allowed; but the literal string
 *  `"null"` — the opaque origin a SANDBOXED iframe or a `file://` page sends — is NOT, since that's a browser
 *  context we can't attribute and must not hand eval to. */
function originAllowed(origin: string | undefined, extra: string[]): boolean {
	if (origin === undefined) {
		return true;
	}

	try {
		const { hostname, protocol } = new URL(origin);

		if ((hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]") && (protocol === "http:" || protocol === "https:")) {
			return true;
		}
	} catch { /* malformed origin — fall through to the allowlist */ }

	return ["https://brianjenkins94.github.io", ...extra].includes(origin);
}

export interface DebugMcp {
	"hub": Hub;
	"store": RecordStore;
	/** A tab's live architecture — its contexts' `$sys.arch` reports (see get_architecture). Per tab: each tab is its
	 *  own tree, and their hubs' ids collide (every editor tab has a `root`, every netsim tab a `referee`). */
	"archOf": (tab: string) => ArchitectureStore | undefined;
	/** The link a tab's traffic arrives on (records carry it), and back — learned as tabs answer discovery. */
	"linkOf": (tab: string) => string | undefined;
	"tabOf": (link: string) => string | undefined;
	/** A preview app's tab's scope (its window — its records are filed under it), when it named one. */
	"scopeOf": (tab: string) => string | undefined;
	/** Call tools SERVED BY A CONNECTED PAGE (the tab hosts them via `serve`); the MCP layer forwards here. */
	"rpc": RpcClient;
	/** How many pages are currently linked in (for tree-state health). */
	"linkCount": () => number;
	/** The editor tabs linked in right now, each answering with its id — the page tools are served under it. */
	"tabs": (timeoutMs?: number) => Promise<TabInfo[]>;
	/** Resolves once the WS server is bound and accepting connections; rejects if it fails to bind (typically
	 *  EADDRINUSE — another debug-mcp already owns the port). Await before announcing "listening". */
	"whenListening": Promise<void>;
	"close": () => Promise<void>;
}

/** Start the debug-mcp WS server on `port` and return its hub, store, rpc client, and a close handle. */
export function createDebugMcp(options: { "port": number; "max"?: number; "origins"?: string[] } = { "port": 7378 }): DebugMcp {
	const hub = createHub({ "id": "debug-mcp" });
	const store = new RecordStore({ "max": options.max });
	const server = new WebSocketServer({ "port": options.port });
	const links = new Set<WebSocket>();
	/** Tabs already warned about being newer than this debug-mcp. */
	const warnedOutdated = new Set<string>();

	// Surface bind success/failure. WebSocketServer emits 'listening' once bound, or 'error' if it can't bind
	// (usually EADDRINUSE: a second debug-mcp on the same port). An 'error' event with NO listener is thrown as
	// an unhandled exception and takes the whole process down — which is exactly how a port collision killed this
	// server. Attach a listener always: reject `whenListening` on a pre-bind failure so the caller can report it
	// and exit cleanly, and merely log any post-bind socket error rather than crash.
	let markListening: () => void;
	let failListening: (error: Error) => void;
	const whenListening = new Promise<void>((resolve, reject) => { markListening = resolve; failListening = reject; });
	let bound = false;

	server.on("listening", () => { bound = true; markListening(); });
	server.on("error", (error: Error) => {
		if (bound) {
			console.error("[debug-mcp] server error:", error.message);
		} else {
			failListening(error);
		}
	});

	// Everything is filed by the link it arrived on — each connected tab is one — so two tabs' same-named contexts
	// stay apart. A tab's id (what the tools take) maps to its link once it answers discovery.
	const tabByLink = new Map<string, string>();
	const archByLink = new Map<string, ArchitectureStore>();

	// An app in one of a tab's previews answers too, over the same link: it maps to the link (its logs and architecture
	// are part of its editor tab's), but the link keeps its editor tab's name.
	const previewTabs = new Map<string, string>();
	/** A preview app's tab → the scope the editor files its records under (its window: TabInfo.scope). */
	const previewScopes = new Map<string, string>();

	/** A tab's latest link (a tab that reconnects — debug-mcp restarted — arrives on a new one). */
	const linkOf = (tab: string): string | undefined => [...tabByLink].reverse().find(([, candidate]) => candidate === tab)?.[0] ?? previewTabs.get(tab);

	hub.subscribe(TAB_HERE, (data, _envelope, origin) => {
		const { tab, preview, scope } = (data ?? {}) as { "tab"?: unknown; "preview"?: unknown; "scope"?: unknown };

		if (origin.link !== undefined && typeof tab === "string") {
			if (preview === true) {
				previewTabs.set(tab, origin.link.id);

				if (typeof scope === "string") {
					previewScopes.set(tab, scope);
				}
			} else {
				tabByLink.set(origin.link.id, tab);
			}
		}
	});

	// The collector leaf. Its interest in `$sys.log.>` is what pulls each context's records across the links.
	// Tagged with the source its subject names (the part link permissions enforce), not the one the record claims.
	hub.subscribe(LOG_SUBJECT + ".>", (data, envelope, origin) => { store.add(tagBySubject(data as HubLogRecord, envelope.subject), origin.link?.id); });
	// And what each page logged before this link could carry it (observability's logBacklog).
	hub.subscribe(LOG_BACKLOG, (data, _envelope, origin) => {
		for (const record of Array.isArray(data) ? data as HubLogRecord[] : []) {
			store.add(record, origin.link?.id);
		}
	});

	// The architecture collector: every context reports its hub topology/traffic + probed channels on $sys.arch.
	hub.subscribe(ARCH_SUBJECT + ".>", (data, envelope, origin) => {
		if (origin.link === undefined || envelope.subject === ARCH_SUBJECT + ".sync") {
			return;
		}

		let arch = archByLink.get(origin.link.id);

		if (arch === undefined) {
			arch = new ArchitectureStore();
			archByLink.set(origin.link.id, arch);
		}

		arch.apply(data as ArchReport);
	});

	// Request client, created eagerly so its reply channel ($rpc.reply.debug-mcp) is advertised to every page as it
	// links in — a page-hosted tool call then never races interest. This is the relay half of "MCP server in the tab".
	const rpc = createRpcClient(hub);

	server.on("connection", (socket, request) => {
		if (!originAllowed(request.headers.origin, options.origins ?? [])) {
			socket.close(1008, "origin not allowed");

			return;
		}

		links.add(socket);

		// A ws socket is EventTarget-shaped (addEventListener + readyState), so websocketTransport drives it
		// unchanged — the same transport the browser end uses. Unlink on close so interest is withdrawn cleanly.
		// Non-transit: every connected page is its OWN tree. Joined, a request in one tab (a preview's
		// virtual.request, a capability.decide) could be answered by another tab's node worker or pod.
		const unlink = hub.link(websocketTransport(socket), { "transit": false });

		// Once our $sys.arch interest has reached the page's hubs, ask them for their full state.
		setTimeout(() => { requestArchSync(hub); }, 500);

		socket.addEventListener("close", () => {
			// Count it gone first, so whoever watches the topology change sees the new link count.
			links.delete(socket);
			unlink();

			// Its architecture goes with it (its records stay, still filed under the link, and its tab id).
			archByLink.delete(unlink.id);
		});
	});

	return {
		"hub": hub,
		"store": store,
		"archOf": (tab) => {
			const link = linkOf(tab);

			return link === undefined ? undefined : archByLink.get(link);
		},
		"linkOf": linkOf,
		"tabOf": (link) => tabByLink.get(link),
		"scopeOf": (tab) => previewScopes.get(tab),
		"rpc": rpc,
		"linkCount": () => links.size,
		// (A short grace after every link's editor tab has answered, for the apps in its previews.)
		// A page newer than this debug-mcp says so (list_tabs shows `outdated`), once on stderr too.
		"tabs": async (timeoutMs) => (await discoverTabs(hub, links.size, timeoutMs, 150)).map((tab) => {
			const marked = markOutdated(tab);

			if (marked.outdated !== undefined && !warnedOutdated.has(tab.tab)) {
				warnedOutdated.add(tab.tab);
				console.error("[debug-mcp] tab " + tab.tab + ": " + marked.outdated);
			}

			return marked;
		}),
		"whenListening": whenListening,
		"close": () => new Promise<void>((resolve) => {
			for (const socket of links) {
				socket.close();
			}

			server.close(() => { resolve(); });
		})
	};
}
