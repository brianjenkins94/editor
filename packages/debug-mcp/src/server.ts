/**
 * The debug-mcp as a hub-tree node. It runs a WebSocket server; every page that links in (its rootHub over a
 * `websocketTransport`) becomes a child in the tree, so the debug-mcp is just another hub — the war2 central-hub
 * analog — that happens to live in Node. A single collector leaf subscribes to the reserved `$sys.log.>`
 * observability namespace and files every record into the store. Because routing is interest-based, the pages
 * forward their span/log traffic here precisely because this collector subscribed to it, and nothing else.
 */
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import { createHub, createRpcClient, websocketTransport } from "@brianjenkins94/hub";
import type { Hub, RpcClient, WebSocketLike } from "@brianjenkins94/hub";

import { RecordStore } from "./store.ts";
import type { HubLogRecord } from "./store.ts";

/** Reserved observability namespace — must match `@brianjenkins94/observability`'s `LOG_SUBJECT` (kept as its
 *  own constant so this Node collector doesn't pull the browser-oriented observability package). */
const LOG_SUBJECT = "$sys.log";

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
	/** Call tools SERVED BY A CONNECTED PAGE (the tab hosts them via `serve`); the MCP layer forwards here. */
	"rpc": RpcClient;
	/** How many pages are currently linked in (for tree-state health). */
	"linkCount": () => number;
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

	// The collector leaf. Its interest in `$sys.log.>` is what pulls each context's records across the links.
	hub.subscribe(LOG_SUBJECT + ".>", (data) => { store.add(data as HubLogRecord); });

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
		const unlink = hub.link(websocketTransport(socket as unknown as WebSocketLike));

		socket.addEventListener("close", () => {
			unlink();
			links.delete(socket);
		});
	});

	return {
		"hub": hub,
		"store": store,
		"rpc": rpc,
		"linkCount": () => links.size,
		"whenListening": whenListening,
		"close": () => new Promise<void>((resolve) => {
			for (const socket of links) {
				socket.close();
			}

			server.close(() => resolve());
		})
	};
}
