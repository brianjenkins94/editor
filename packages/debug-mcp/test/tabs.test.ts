/**
 * Two tabs whose hubs have the same ids (every editor tab has a `root`): debug-mcp must keep their logs and their
 * architecture apart, filed by the tab they came from. Real WebSockets, stand-in tabs. Runs under tsx.
 */
import type { AddressInfo } from "node:net";
import type { Hub } from "@brianjenkins94/hub";
import * as assert from "node:assert/strict";
import { createServer } from "node:net";

import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHub, portTransport, websocketTransport } from "@brianjenkins94/hub";

import { createArchReporter } from "../../observability/src/arch.ts";
import { TAB_DISCOVER, TAB_HERE } from "../../observability/src/tabs.ts";
import { createMcpServer } from "../src/mcp.ts";
import { createDebugMcp } from "../src/server.ts";

let debugMcp: ReturnType<typeof createDebugMcp>;
let port: number;
let client: Client;
const sockets = new Map<string, WebSocket>();
const channels: MessageChannel[] = [];
const disposers: (() => void)[] = [];

/** A stand-in tab `tab`: a `root` hub (the same id in every tab) with a worker hub `worker` under it, both reporting
 *  their architecture, and a log line from `root`. */
async function openTab(tab: string, worker: string): Promise<void> {
	const root = createHub({ "id": "root" });
	const child = createHub({ "id": worker });
	const channel = new MessageChannel();

	channels.push(channel);
	root.link(portTransport(channel.port1));
	child.link(portTransport(channel.port2));

	for (const hub of [root, child]) {
		disposers.push(createArchReporter(hub).dispose);
	}

	root.subscribe(TAB_DISCOVER, (data) => {
		root.publish(TAB_HERE, { "query": (data as { "query": string }).query, "tab": tab, "url": "http://localhost:5180/" + tab, "title": tab, "visible": true, "focused": false });
	});
	await connect(root, tab);
	root.publish("$sys.log.root", { "kind": "log", "level": "info", "message": "hello from " + tab, "context": { "source": "root" }, "time": Date.now(), "depth": 0 });
}

async function connect(hub: Hub, tab: string): Promise<void> {
	const socket = new WebSocket("ws://localhost:" + port);

	await new Promise((resolve) => { socket.addEventListener("open", resolve, { "once": true }); });
	await hub.link(websocketTransport(socket as unknown as Parameters<typeof websocketTransport>[0])).ready;
	sockets.set(tab, socket);
}

function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const probe = createServer().listen(0, () => {
			const { port: free } = probe.address() as AddressInfo;

			probe.close(() => { resolve(free); });
		});
	});
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ "isError"?: boolean; "value": unknown }> {
	const result = await client.callTool({ "name": name, "arguments": args }) as { "isError"?: boolean; "content": { "text": string }[] };
	const text = result.content[0]?.text ?? "";

	return { "isError": result.isError, "value": ((): unknown => { try { return JSON.parse(text); } catch { return text; } })() };
}

type Row = { "message": string; "source": string; "tab"?: string };
type Architecture = { "nodes": { "id": string }[] };

async function queryLogs(args: Record<string, unknown>): Promise<Row[]> {
	return (await call("query_logs", args)).value as Row[];
}

async function architecture(args: Record<string, unknown> = {}): Promise<{ "isError"?: boolean; "value": Architecture }> {
	const { isError, value } = await call("get_architecture", args);

	return { "isError": isError, "value": value as Architecture };
}

async function eventually<T>(what: string, probe: () => Promise<T | undefined>): Promise<T> {
	for (let attempt = 0; attempt < 60; attempt += 1) {
		const value = await probe();

		if (value !== undefined) {
			return value;
		}

		await new Promise((resolve) => { setTimeout(resolve, 100); });
	}

	throw new Error("timed out waiting for " + what);
}

before(async () => {
	port = await freePort();
	debugMcp = createDebugMcp({ "port": port });
	await debugMcp.whenListening;

	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

	await createMcpServer(debugMcp).connect(serverSide);
	client = new Client({ "name": "test", "version": "0.0.0" });
	await client.connect(clientSide);
	await openTab("t1", "worker-a");
	await openTab("t2", "worker-b");
});

after(async () => {
	disposers.forEach((dispose) => { dispose(); });

	for (const { port1, port2 } of channels) {
		port1.close();
		port2.close();
	}

	sockets.forEach((socket) => { socket.close(); });
	await client.close();
	await debugMcp.close();
});

test("each record names the tab it came from, and query_logs can take one tab's", async () => {
	const rows = await eventually("both tabs' records", async () => {
		const value = await queryLogs({ "source": "root", "textIncludes": "hello from" });

		return value.length === 2 ? value : undefined;
	});

	assert.deepEqual(rows.map((row) => [row.message, row.tab ?? ""]).sort(([left], [right]) => left.localeCompare(right)), [["hello from t1", "t1"], ["hello from t2", "t2"]]);
	assert.deepEqual((await queryLogs({ "source": "root", "textIncludes": "hello from", "tab": "t2" })).map((row) => row.message), ["hello from t2"], "same-named sources, one tab's");

	const unknown = await call("query_logs", { "tab": "nope" });

	assert.equal(unknown.isError, true);
});

test("get_architecture shows one tab's contexts, never the two merged — and asks which, when several are connected", async () => {
	const ambiguous = await call("get_architecture");

	assert.equal(ambiguous.isError, true);
	assert.match(String(ambiguous.value), /several editor tabs/u);

	for (const [tab, mine, theirs] of [["t1", "worker-a", "worker-b"], ["t2", "worker-b", "worker-a"]]) {
		const snapshot = await eventually(`${tab}'s architecture`, async () => {
			const { isError, value } = await architecture({ "tab": tab });

			return isError !== true && value.nodes.some((node) => node.id === mine) ? value : undefined;
		});
		const ids = snapshot.nodes.map((node) => node.id);

		assert.ok(ids.includes("root"), `${tab}: ${ids.join(", ")}`);
		assert.ok(!ids.includes(theirs), `${tab} shows the other tab's ${theirs}: ${ids.join(", ")}`);
	}
});

test("once a tab goes, its architecture goes with it, and the one left needs no `tab`", async () => {
	sockets.get("t1")?.close();
	await eventually("one tab left", async () => (debugMcp.linkCount() === 1 ? true : undefined));

	const { isError, value } = await architecture();

	assert.notEqual(isError, true, JSON.stringify(value));
	assert.ok(value.nodes.some((node) => node.id === "worker-b"));
	assert.equal(debugMcp.archOf("t1"), undefined);
	// Its records stay, still filed under it.
	assert.deepEqual((await queryLogs({ "tab": "t1", "textIncludes": "hello from" })).map((row) => row.message), ["hello from t1"]);
});
