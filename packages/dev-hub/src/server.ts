/**
 * The dev-hub as a hub-tree node. It runs a WebSocket server; every page that links in (its rootHub over a
 * `websocketTransport`) becomes a child in the tree, so the dev-hub is just another hub — the war2 central-hub
 * analog — that happens to live in Node. A single collector leaf subscribes to the reserved `$sys.log.>`
 * observability namespace and files every record into the store. Because routing is interest-based, the pages
 * forward their span/log traffic here precisely because this collector subscribed to it, and nothing else.
 */
import { WebSocketServer } from "ws";
import type { WebSocket } from "ws";

import { createHub, websocketTransport } from "@brianjenkins94/hub";
import type { Hub } from "@brianjenkins94/hub";

import { RecordStore } from "./store.ts";
import type { HubLogRecord } from "./store.ts";

/** Reserved observability namespace — must match the editor's telemetry.ts `LOG_SUBJECT`. */
const LOG_SUBJECT = "$sys.log";

export interface DevHub {
	"hub": Hub;
	"store": RecordStore;
	/** How many pages are currently linked in (for tree-state health). */
	"linkCount": () => number;
	"close": () => Promise<void>;
}

/** Start the dev-hub WS server on `port` and return its hub, store, and a close handle. */
export function createDevHub(options: { "port": number; "max"?: number } = { "port": 7378 }): DevHub {
	const hub = createHub({ "id": "dev-hub" });
	const store = new RecordStore({ "max": options.max });
	const server = new WebSocketServer({ "port": options.port });
	const links = new Set<WebSocket>();

	// The collector leaf. Its interest in `$sys.log.>` is what pulls each context's records across the links.
	hub.subscribe(LOG_SUBJECT + ".>", (data) => { store.add(data as HubLogRecord); });

	server.on("connection", (socket) => {
		links.add(socket);

		// A ws socket is EventTarget-shaped (addEventListener + readyState), so websocketTransport drives it
		// unchanged — the same transport the browser end uses. Unlink on close so interest is withdrawn cleanly.
		const unlink = hub.link(websocketTransport(socket as unknown as import("@brianjenkins94/hub").WebSocketLike));

		socket.addEventListener("close", () => {
			unlink();
			links.delete(socket);
		});
	});

	return {
		"hub": hub,
		"store": store,
		"linkCount": () => links.size,
		"close": () => new Promise<void>((resolve) => {
			for (const socket of links) {
				socket.close();
			}

			server.close(() => resolve());
		})
	};
}
