/**
 * The dev-hub as a hub-tree node. It runs a WebSocket server; every page that links in (its rootHub over a
 * `websocketTransport`) becomes a child in the tree, so the dev-hub is just another hub — the war2 central-hub
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
 *  PUBLIC site can still reach a dev-hub on YOUR machine over `ws://localhost` (loopback is exempt from
 *  mixed-content blocking). The check matters: without it any site you visit could open your dev-hub and read
 *  your logs, or call the page tools. Extra origins via `origins`. A connection with no Origin (a non-browser
 *  client, e.g. tests) is allowed. */
function originAllowed(origin: string | undefined, extra: string[]): boolean {
	if (origin === undefined || origin === "null") {
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

export interface DevHub {
	"hub": Hub;
	"store": RecordStore;
	/** Call tools SERVED BY A CONNECTED PAGE (the tab hosts them via `serve`); the MCP layer forwards here. */
	"rpc": RpcClient;
	/** How many pages are currently linked in (for tree-state health). */
	"linkCount": () => number;
	"close": () => Promise<void>;
}

/** Start the dev-hub WS server on `port` and return its hub, store, rpc client, and a close handle. */
export function createDevHub(options: { "port": number; "max"?: number; "origins"?: string[] } = { "port": 7378 }): DevHub {
	const hub = createHub({ "id": "dev-hub" });
	const store = new RecordStore({ "max": options.max });
	const server = new WebSocketServer({ "port": options.port });
	const links = new Set<WebSocket>();

	// The collector leaf. Its interest in `$sys.log.>` is what pulls each context's records across the links.
	hub.subscribe(LOG_SUBJECT + ".>", (data) => { store.add(data as HubLogRecord); });

	// Request client, created eagerly so its reply channel ($rpc.reply.dev-hub) is advertised to every page as it
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
		"close": () => new Promise<void>((resolve) => {
			for (const socket of links) {
				socket.close();
			}

			server.close(() => resolve());
		})
	};
}
