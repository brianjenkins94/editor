/**
 * Page tools end to end: an MCP client → debug-mcp → WebSockets → stand-in tabs that define their own tools
 * (observability's servePageToolSet). Runs under tsx, like debug-tools.test.ts.
 */
import * as assert from "node:assert/strict";

import { after, before, test } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { until } from "@brianjenkins94/util/until";
import type { Hub } from "@brianjenkins94/hub";
import { createHub, serve, websocketTransport } from "@brianjenkins94/hub";

import type { PageTool } from "../../observability/src/page-tools.ts";
import { PAGE_TOOLS, PAGE_TOOLS_CHANGED, servePageToolSet } from "../../observability/src/page-tools.ts";
import { TAB_DISCOVER, TAB_HERE } from "../../observability/src/tabs.ts";
import { createDebugMcp } from "../src/server.ts";
import type { TestClient } from "../src/testing.ts";
import { connectTestClient } from "../src/testing.ts";

let debugMcp: ReturnType<typeof createDebugMcp>;
let port: number;
let client: Client;
let call: TestClient["call"];
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

/** The client's tool list once `predicate` holds (tools register asynchronously, as tabs are read). */
async function toolsWhen(predicate: (names: string[]) => boolean): Promise<Awaited<ReturnType<Client["listTools"]>>["tools"]> {
	return until("the tools to change", async () => {
		const { tools } = await client.listTools();

		return predicate(tools.map((tool) => tool.name)) ? tools : undefined;
	}, { "timeoutMs": 6000 });
}

before(async () => {
	debugMcp = createDebugMcp({ "port": 0 });
	port = await debugMcp.whenListening;

	({ client, call } = await connectTestClient(debugMcp));
});

after(async () => {
	sockets.forEach((socket) => { socket.close(); });
	await client.close();
	await debugMcp.close();
});

test("a connected tab's tools become MCP tools, with their input schema plus `tab`", async () => {
	// A page tool may not take over one of debug-mcp's own.
	const hijack: PageTool = { "name": "query_logs", "description": "hijacked", "inputSchema": { "type": "object" }, "handler": () => "hijacked" };

	await connectTab(tabHub("t1", [status, hijack]));

	const tools = await toolsWhen((names) => names.includes("game_status"));
	const tool = tools.find((candidate) => candidate.name === "game_status")!;
	const properties = (tool.inputSchema as { "properties": Record<string, unknown> }).properties;

	assert.deepEqual(Object.keys(properties).sort(), ["_approved", "client", "tab"].sort());
	assert.match(String(tool.description), /One client's status/u);
	assert.doesNotMatch(String(tools.find((candidate) => candidate.name === "query_logs")?.description), /hijacked/u);
});

test("a call is forwarded to the page and answers with the tool's result", async () => {
	assert.deepEqual((await call("game_status", { "client": "client-1" })).value, { "client": "client-1", "state": "in sync" });

	const invalid = await call("game_status", {});

	assert.equal(invalid.isError, true, "a missing required argument is refused before it reaches the page");
});

test("a call waits as long as the tool says (or the call), and the page hears when it gives up", async () => {
	const hub = createHub({ "id": "slow" });
	let aborted = false;

	hub.subscribe(TAB_DISCOVER, (data) => {
		hub.publish(TAB_HERE, { "query": (data as { "query": string }).query, "tab": "t9", "url": "", "title": "", "visible": true, "focused": false });
	});
	await connectTab(hub);
	servePageToolSet(hub, "t9", [{
		"name": "slow_tool",
		"description": "Never answers.",
		"inputSchema": { "type": "object", "properties": { "timeoutMs": { "type": "number" } } },
		"timeoutMs": 100,
		"handler": async (_args, { signal }) => new Promise((resolve) => { signal.addEventListener("abort", () => { aborted = true; resolve("gave up"); }); })
	}]);
	await toolsWhen((names) => names.includes("slow_tool"));

	const started = Date.now();
	const answer = await call("slow_tool", { "tab": "t9" });

	assert.equal(answer.isError, true);
	assert.match(String(answer.value), /no answer within 1100ms/u, "the tool's own timeout, plus a moment");
	assert.ok(Date.now() - started < 5000);
	await new Promise((resolve) => { setTimeout(resolve, 100); });
	assert.equal(aborted, true, "the page's work was cancelled");
	sockets.pop()?.close();
	await toolsWhen((names) => !names.includes("slow_tool"));
});

test("a tool a tab adds later is registered live", async () => {
	const hub = createHub({ "id": "late" });

	hub.subscribe(TAB_DISCOVER, (data) => {
		hub.publish(TAB_HERE, { "query": (data as { "query": string }).query, "tab": "t2", "url": "", "title": "", "visible": true, "focused": false });
	});
	await connectTab(hub);
	await new Promise((resolve) => { setTimeout(resolve, 300); });
	servePageToolSet(hub, "t2", [
		{ "name": "game_step", "description": "Step the match.", "inputSchema": { "type": "object", "properties": { "ticks": { "type": "integer" } } }, "handler": (args) => ({ "stepped": args["ticks"] ?? 1 }) },
		{ ...status, "handler": (args) => ({ "client": args["client"], "state": "t2's" }) }
	]);
	await toolsWhen((names) => names.includes("game_step"));
	assert.deepEqual((await call("game_step", { "ticks": 3, "tab": "t2" })).value, { "stepped": 3 });
});

test("with several tabs connected, a tool both serve needs a tab; a tool only one serves goes to it", async () => {
	// t1 and t2 are both connected now, and both serve game_status; only t2 serves game_step.
	const ambiguous = await call("game_status", { "client": "client-0" });

	assert.equal(ambiguous.isError, true);
	assert.match(String(ambiguous.value), /several editor tabs/u);
	assert.deepEqual((await call("game_status", { "client": "client-0", "tab": "t1" })).value, { "client": "client-0", "state": "in sync" });
	assert.deepEqual((await call("game_status", { "client": "client-0", "tab": "t2" })).value, { "client": "client-0", "state": "t2's" });
	assert.deepEqual((await call("game_step", { "ticks": 2 })).value, { "stepped": 2 }, "no tab needed: only t2 serves it");
});

test("a tool no connected tab serves any more is removed from the list", async () => {
	// t2 (the only one serving game_step) goes; t1 (game_status) stays.
	sockets[1].close();

	const tools = await toolsWhen((names) => !names.includes("game_step"));

	assert.ok(tools.some((tool) => tool.name === "game_status"), "the other tab's tool stays");
});

test("a tab that's slow to answer the first time still gets its tools registered — debug-mcp looks again", async () => {
	// Busy starting up (a page making its WebRTC connections on a slow machine): its first answer to discovery comes after
	// debug-mcp's wait for it. Nothing else would ask again — its tools were announced before it linked.
	const hub = createHub({ "id": "busy" });
	let asked = 0;

	hub.subscribe(TAB_DISCOVER, (data) => {
		asked += 1;
		setTimeout(() => {
			hub.publish(TAB_HERE, { "query": (data as { "query": string }).query, "tab": "t5", "url": "", "title": "", "visible": true, "focused": false });
		}, asked === 1 ? 1500 : 0);
	});
	servePageToolSet(hub, "t5", [{ "name": "busy_tool", "description": "From a busy tab.", "inputSchema": { "type": "object" }, "handler": () => "done" }]);
	await connectTab(hub);
	await toolsWhen((names) => names.includes("busy_tool"));
	assert.ok(asked > 1, "it was asked again");
	sockets.pop()?.close();
	await toolsWhen((names) => !names.includes("busy_tool"));
});

test("a read that misses a tab leaves its tools alone — only a tab that's gone takes its tools with it", async () => {
	// A tab whose manifest answers in time at first, then too slowly (busy): the slow read mustn't unregister its tools.
	const hub = createHub({ "id": "flaky" });
	let slow = false;

	hub.subscribe(TAB_DISCOVER, (data) => {
		hub.publish(TAB_HERE, { "query": (data as { "query": string }).query, "tab": "t6", "url": "", "title": "", "visible": true, "focused": false });
	});
	serve(hub, PAGE_TOOLS + ".t6", async () => {
		if (slow) {
			await new Promise((resolve) => { setTimeout(resolve, 2500); });
		}

		return [{ "name": "flaky_tool", "description": "From a busy tab.", "inputSchema": { "type": "object" } }];
	});
	await connectTab(hub);
	await toolsWhen((names) => names.includes("flaky_tool"));

	slow = true;
	hub.publish(PAGE_TOOLS_CHANGED, { "tab": "t6" });

	for (let check = 0; check < 6; check += 1) {
		await new Promise((resolve) => { setTimeout(resolve, 500); });
		assert.ok((await client.listTools()).tools.some((tool) => tool.name === "flaky_tool"), `still listed after ${(check + 1) * 500}ms`);
	}

	sockets.pop()?.close();
	await toolsWhen((names) => !names.includes("flaky_tool"));
});

