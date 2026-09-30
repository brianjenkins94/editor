/**
 * An app running in an editor preview is a tab of its own (its own page tools) that rides its editor tab's link: its
 * hubs join the editor's tree (observability's linkPreviewHost), so everything it sends arrives over the editor's
 * socket. Stand-ins for both, over one real WebSocket. Runs under tsx.
 */
import type { AddressInfo } from "node:net";
import * as assert from "node:assert/strict";
import { createServer } from "node:net";

import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Hub } from "@brianjenkins94/hub";
import { createHub, pipe, websocketTransport } from "@brianjenkins94/hub";

import { servePageToolSet } from "../../observability/src/page-tools.ts";
import { TAB_DISCOVER, TAB_HERE } from "../../observability/src/tabs.ts";
import { createMcpServer } from "../src/mcp.ts";
import { createDebugMcp } from "../src/server.ts";

let debugMcp: ReturnType<typeof createDebugMcp>;
let client: Client;
let socket: WebSocket;
let app: Hub;

/** Answer tab discovery as `tab` (a preview's app says so). */
function answersAs(hub: Hub, tab: string, preview: boolean): void {
	hub.subscribe(TAB_DISCOVER, (data) => {
		hub.publish(TAB_HERE, { "query": (data as { "query": string }).query, "tab": tab, "url": preview ? "http://localhost:5173/__virtual__/ed/5173/" : "http://localhost:5173/", "title": tab, "visible": true, "focused": false, ...preview ? { "preview": true, "scope": "preview:5173" } : {} });
	});
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ "isError"?: boolean; "value": unknown }> {
	const result = await client.callTool({ "name": name, "arguments": args }) as { "isError"?: boolean; "content": { "text": string }[] };
	const text = result.content[0]?.text ?? "";

	return { "isError": result.isError, "value": ((): unknown => { try { return JSON.parse(text); } catch { return text; } })() };
}

async function eventually<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const value = await probe().catch(() => undefined);

		if (value !== undefined) {
			return value;
		}

		await new Promise((resolve) => { setTimeout(resolve, 100); });
	}

	throw new Error("timed out waiting for " + what);
}

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

	// The editor tab: its root hub on the socket, serving a tool of its own.
	const root = createHub({ "id": "root" });

	answersAs(root, "ed", false);
	servePageToolSet(root, "ed", [{ "name": "editor_thing", "description": "The editor's.", "inputSchema": { "type": "object" }, "handler": () => "editor" }]);
	socket = new WebSocket("ws://localhost:" + port);
	await new Promise((resolve) => { socket.addEventListener("open", resolve, { "once": true }); });
	await root.link(websocketTransport(socket as unknown as Parameters<typeof websocketTransport>[0])).ready;

	// The app in its preview: its page hub linked into the editor's tree, serving its own tools.
	const [up, down] = pipe();

	app = createHub({ "id": "page" });
	root.link(up);
	await app.link(down).ready;
	answersAs(app, "app1", true);
	servePageToolSet(app, "app1", [{ "name": "app_status", "description": "The app's.", "inputSchema": { "type": "object" }, "handler": () => "app" }]);
});

after(async () => {
	socket?.close();
	await client?.close();
	await debugMcp?.close();
});

test("the app is a tab of its own (marked a preview), riding its editor tab's link", async () => {
	const tabs = await eventually("both tabs", async () => {
		const { value } = await call("list_tabs");

		return Array.isArray(value) && value.length === 2 ? value as { "tab": string; "preview"?: boolean }[] : undefined;
	});

	assert.deepEqual(tabs.map((tab) => [tab.tab, tab.preview === true]).sort(([left], [right]) => String(left).localeCompare(String(right))), [["app1", true], ["ed", false]]);
	assert.equal(debugMcp.linkCount(), 1, "one socket");
	assert.equal(debugMcp.linkOf("app1"), debugMcp.linkOf("ed"));
	assert.equal(debugMcp.tabOf(debugMcp.linkOf("ed")!), "ed", "the link keeps its editor tab's name");
});

test("a tool only the app serves needs no tab; the editor tab stays the default for the rest", async () => {
	await eventually("the app's tool", async () => ((await client.listTools()).tools.some((tool) => tool.name === "app_status") ? true : undefined));
	assert.deepEqual(await call("app_status"), { "isError": undefined, "value": "app" });
	assert.deepEqual(await call("editor_thing"), { "isError": undefined, "value": "editor" });
	// A tool that isn't a page tool (the tab defaults to the editor's, though two tabs answered).
	assert.doesNotMatch(String((await call("get_architecture")).value), /several editor tabs/u);
});

test("the app's logs arrive over its editor tab's link, filed under that tab", async () => {
	app.publish("$sys.log.page", { "kind": "log", "level": "info", "message": "from the app", "context": { "source": "page" }, "time": Date.now(), "depth": 0 });

	const records = await eventually("the app's record", async () => {
		const { value } = await call("query_logs", { "source": "page" });

		return Array.isArray(value) && value.length > 0 ? value as { "tab"?: string }[] : undefined;
	});

	assert.equal(records[0].tab, "ed");
});

test("a query for the app's tab returns the app's records — its window's scope — not the editor tab's around it", async () => {
	const record = (source: string, message: string) => ({ "kind": "log", "level": "info", "message": message, "context": { "source": source }, "time": Date.now(), "depth": 0 });

	// As the editor's shell scopes them: the app's page under its window, and the window's own console records.
	app.publish("$sys.log.preview:5173/page", record("preview:5173/page", "the app's page"));
	app.publish("$sys.log.preview:5173", record("preview:5173", "the app's console"));

	const messages = await eventually("the app's scoped records", async () => {
		const { value } = await call("query_logs", { "tab": "app1", "textIncludes": "the app" });

		return Array.isArray(value) && value.length === 2 ? (value as { "message": string }[]).map((entry) => entry.message).sort() : undefined;
	});

	assert.deepEqual(messages, ["the app's console", "the app's page"]);

	const { value } = await call("query_logs", { "tab": "app1" });

	assert.ok((value as { "source": string }[]).every((entry) => entry.source === "preview:5173" || entry.source.startsWith("preview:5173/")), "nothing of the editor tab's");
	assert.ok(((await call("query_logs", { "tab": "ed", "textIncludes": "the app" })).value as unknown[]).length >= 2, "while the editor tab's query still has everything on its link");
});
