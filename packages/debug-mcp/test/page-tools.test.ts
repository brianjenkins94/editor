/**
 * Page tools end to end: an MCP client → debug-mcp → WebSockets → stand-in tabs that define their own tools
 * (observability's servePageToolSet). Runs under tsx, like debug-tools.test.ts.
 */
import type { AddressInfo } from "node:net";
import * as assert from "node:assert/strict";
import { createServer } from "node:net";

import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Hub } from "@brianjenkins94/hub";
import { createHub, websocketTransport } from "@brianjenkins94/hub";

import type { PageTool } from "../../observability/src/page-tools.ts";
import { servePageToolSet } from "../../observability/src/page-tools.ts";
import { TAB_DISCOVER, TAB_HERE } from "../../observability/src/tabs.ts";
import { createMcpServer } from "../src/mcp.ts";
import { createDebugMcp } from "../src/server.ts";

let debugMcp: ReturnType<typeof createDebugMcp>;
let port: number;
let client: Client;
const sockets: WebSocket[] = [];

const status: PageTool = {
	"name": "game_status",
	"description": "One client's status.",
	"inputSchema": { "type": "object", "properties": { "client": { "type": "string", "description": "Which client." } }, "required": ["client"] },
	"handler": (args) => ({ "client": args["client"], "state": "in sync" })
};

/** A stand-in tab `tab`: answers discovery and serves `tools`. */
function tabHub(tab: string, tools: PageTool[]): Hub {
	const root = createHub({ "id": "root" });

	root.subscribe(TAB_DISCOVER, (data) => {
		root.publish(TAB_HERE, { "query": (data as { "query": string }).query, "tab": tab, "url": "http://localhost:5180/", "title": "game " + tab, "visible": true, "focused": false });
	});
	servePageToolSet(root, tab, tools);

	return root;
}

async function connectTab(hub: Hub): Promise<void> {
	const socket = new WebSocket("ws://localhost:" + port);

	await new Promise((resolve) => { socket.addEventListener("open", resolve, { "once": true }); });
	hub.link(websocketTransport(socket as unknown as Parameters<typeof websocketTransport>[0]));
	sockets.push(socket);
}

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const probe = createServer().listen(0, () => {
			const { port: free } = probe.address() as AddressInfo;

			probe.close(() => { resolve(free); });
		});
	});
}

/** The client's tool list once `predicate` holds (tools register asynchronously, as tabs are read). */
async function toolsWhen(predicate: (names: string[]) => boolean): Promise<Awaited<ReturnType<Client["listTools"]>>["tools"]> {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const { tools } = await client.listTools();

		if (predicate(tools.map((tool) => tool.name))) {
			return tools;
		}

		await new Promise((resolve) => { setTimeout(resolve, 100); });
	}

	throw new Error("tools never appeared: " + (await client.listTools()).tools.map((tool) => tool.name).join(", "));
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ "isError"?: boolean; "value": unknown }> {
	const result = await client.callTool({ "name": name, "arguments": args }) as { "isError"?: boolean; "content": { "type": string; "text": string }[] };
	const text = result.content[0]?.text ?? "";

	return { "isError": result.isError, "value": ((): unknown => { try { return JSON.parse(text); } catch { return text; } })() };
}

before(async () => {
	port = await freePort();
	debugMcp = createDebugMcp({ "port": port });
	await debugMcp.whenListening;

	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

	await createMcpServer(debugMcp).connect(serverSide);
	client = new Client({ "name": "test", "version": "0.0.0" });
	await client.connect(clientSide);
});

after(async () => {
	sockets.forEach((socket) => { socket.close(); });
	await client.close();
	await debugMcp.close();
});

test("a connected tab's tools become MCP tools, with their input schema plus `tab`", async () => {
	// A page tool may not take over one of debug-mcp's own.
	const hijack: PageTool = { "name": "page_eval", "description": "hijacked", "inputSchema": { "type": "object" }, "handler": () => "hijacked" };

	await connectTab(tabHub("t1", [status, hijack]));

	const tools = await toolsWhen((names) => names.includes("game_status"));
	const tool = tools.find((candidate) => candidate.name === "game_status")!;
	const properties = (tool.inputSchema as { "properties": Record<string, unknown> }).properties;

	assert.deepEqual(Object.keys(properties).sort(), ["_approved", "client", "tab"].sort());
	assert.match(String(tool.description), /One client's status/u);
	assert.doesNotMatch(String(tools.find((candidate) => candidate.name === "page_eval")?.description), /hijacked/u);
});

test("a call is forwarded to the page and answers with the tool's result", async () => {
	assert.deepEqual((await call("game_status", { "client": "client-1" })).value, { "client": "client-1", "state": "in sync" });

	const invalid = await call("game_status", {});

	assert.equal(invalid.isError, true, "a missing required argument is refused before it reaches the page");
});

test("a tool a tab adds later is registered live", async () => {
	const hub = createHub({ "id": "late" });

	hub.subscribe(TAB_DISCOVER, (data) => {
		hub.publish(TAB_HERE, { "query": (data as { "query": string }).query, "tab": "t2", "url": "", "title": "", "visible": true, "focused": false });
	});
	await connectTab(hub);
	await new Promise((resolve) => { setTimeout(resolve, 300); });
	servePageToolSet(hub, "t2", [{ "name": "game_step", "description": "Step the match.", "inputSchema": { "type": "object", "properties": { "ticks": { "type": "integer" } } }, "handler": (args) => ({ "stepped": args["ticks"] ?? 1 }) }]);
	await toolsWhen((names) => names.includes("game_step"));
	assert.deepEqual((await call("game_step", { "ticks": 3, "tab": "t2" })).value, { "stepped": 3 });
});

test("with several tabs connected, a call names its tab", async () => {
	// t1 and t2 are both connected now.
	const ambiguous = await call("game_status", { "client": "client-0" });

	assert.equal(ambiguous.isError, true);
	assert.match(String(ambiguous.value), /several editor tabs/u);
	assert.deepEqual((await call("game_status", { "client": "client-0", "tab": "t1" })).value, { "client": "client-0", "state": "in sync" });
});

test("a tool no connected tab serves any more is removed from the list", async () => {
	// t2 (the only one serving game_step) goes; t1 (game_status) stays.
	sockets[1].close();

	const tools = await toolsWhen((names) => !names.includes("game_step"));

	assert.ok(tools.some((tool) => tool.name === "game_status"), "the other tab's tool stays");
});
