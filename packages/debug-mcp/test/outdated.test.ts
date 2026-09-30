/**
 * A page newer than the debug-mcp it's linked to: list_tabs says so, instead of the debug-mcp silently ignoring what it
 * doesn't know. One stand-in tab over a real WebSocket. Runs under tsx.
 */
import type { AddressInfo } from "node:net";
import * as assert from "node:assert/strict";
import { createServer } from "node:net";

import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHub, websocketTransport } from "@brianjenkins94/hub";

import { OBSERVABILITY_PROTOCOL, TAB_DISCOVER, TAB_HERE } from "../../observability/src/tabs.ts";
import { createMcpServer } from "../src/mcp.ts";
import { createDebugMcp } from "../src/server.ts";

let debugMcp: ReturnType<typeof createDebugMcp>;
let client: Client;
let socket: WebSocket;

before(async () => {
	const port = await new Promise<number>((resolve) => {
		const probe = createServer().listen(0, () => {
			const { port: free } = probe.address() as AddressInfo;

			probe.close(() => { resolve(free); });
		});
	});

	debugMcp = createDebugMcp({ "port": port });
	await debugMcp.whenListening;

	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

	await createMcpServer(debugMcp).connect(serverSide);
	client = new Client({ "name": "test", "version": "0.0.0" });
	await client.connect(clientSide);

	const root = createHub({ "id": "root" });

	// A page from the future: it speaks a protocol one past this debug-mcp's.
	root.subscribe(TAB_DISCOVER, (data) => {
		root.publish(TAB_HERE, { "query": (data as { "query": string }).query, "tab": "new", "url": "http://localhost:5173/", "title": "new", "visible": true, "focused": true, "protocol": OBSERVABILITY_PROTOCOL + 1 });
	});
	socket = new WebSocket("ws://localhost:" + port);
	await new Promise((resolve) => { socket.addEventListener("open", resolve, { "once": true }); });
	await root.link(websocketTransport(socket as unknown as Parameters<typeof websocketTransport>[0])).ready;
});

after(async () => {
	socket?.close();
	await client?.close();
	await debugMcp?.close();
});

test("list_tabs says when a page is newer than this debug-mcp, and what to do", async () => {
	let tab: { "tab": string; "outdated"?: string } | undefined;

	// (Discovery answers once the page's interest has reached debug-mcp.)
	for (let attempt = 0; attempt < 30 && tab === undefined; attempt += 1) {
		const result = await client.callTool({ "name": "list_tabs", "arguments": {} }) as { "content": { "text": string }[] };

		[tab] = JSON.parse(result.content[0]!.text) as { "tab": string; "outdated"?: string }[];
	}

	assert.equal(tab?.tab, "new");
	assert.match(tab?.outdated ?? "", /restart/u);
});
