/**
 * Two tabs whose hubs have the same ids (every editor tab has a `root`): debug-mcp must keep their logs and their
 * architecture apart, filed by the tab they came from. Real WebSockets, stand-in tabs. Runs under tsx.
 */
import type { Hub } from "@brianjenkins94/hub";
import * as assert from "node:assert/strict";

import { after, before, test } from "node:test";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { until } from "@brianjenkins94/util/until";
import { createHub, portTransport, websocketTransport } from "@brianjenkins94/hub";

import { createArchReporter } from "../../observability/src/arch.ts";
import { TAB_DISCOVER, TAB_HERE } from "../../observability/src/tabs.ts";
import { createDebugMcp } from "../src/server.ts";
import type { TestClient } from "../src/testing.ts";
import { connectTestClient } from "../src/testing.ts";

let debugMcp: ReturnType<typeof createDebugMcp>;
let port: number;
let client: Client;
let call: TestClient["call"];
const sockets = new Map<string, WebSocket>();
const channels: MessageChannel[] = [];
const disposers: (() => void)[] = [];
const roots = new Map<string, Hub>();

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
	roots.set(tab, root);
	root.publish("$sys.log.root", { "kind": "log", "level": "info", "message": "hello from " + tab, "context": { "source": "root" }, "time": Date.now(), "depth": 0 });
	// A span still open — with the same span id in both tabs (ids are per context, and the contexts share a name).
	root.publish("$sys.log.root", { "kind": "span-open", "level": "info", "message": "load", "span": "load", "spanId": "s1", "context": { "source": "root" }, "time": Date.now(), "depth": 0 });
}

async function connect(hub: Hub, tab: string): Promise<void> {
	const socket = new WebSocket("ws://localhost:" + port);

	await new Promise((resolve) => { socket.addEventListener("open", resolve, { "once": true }); });
	await hub.link(websocketTransport(socket as unknown as Parameters<typeof websocketTransport>[0])).ready;
	sockets.set(tab, socket);
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

before(async () => {
	debugMcp = createDebugMcp({ "port": 0 });
	port = await debugMcp.whenListening;

	({ client, call } = await connectTestClient(debugMcp));
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
	const rows = await until("both tabs' records", async () => {
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
		const snapshot = await until(`${tab}'s architecture`, async () => {
			const { isError, value } = await architecture({ "tab": tab });

			return isError !== true && value.nodes.some((node) => node.id === mine) ? value : undefined;
		});
		const ids = snapshot.nodes.map((node) => node.id);

		assert.ok(ids.includes("root"), `${tab}: ${ids.join(", ")}`);
		assert.ok(!ids.includes(theirs), `${tab} shows the other tab's ${theirs}: ${ids.join(", ")}`);
	}
});

test("query_spans keeps two tabs' same-id spans apart, and takes one tab's", async () => {
	type Span = { "name"?: string; "open": boolean; "tab"?: string };
	const spans = await until("both tabs' spans", async () => {
		const value = (await call("query_spans", { "name": "load" })).value as Span[];

		return value.length === 2 ? value : undefined;
	});

	assert.deepEqual(spans.map((span) => [span.tab, span.open]).sort(([left], [right]) => String(left).localeCompare(String(right))), [["t1", true], ["t2", true]]);
	assert.deepEqual(((await call("query_spans", { "name": "load", "tab": "t2" })).value as Span[]).map((span) => span.tab), ["t2"]);
});

test("get_tree_state shows each tab's contexts separately, or one tab's", async () => {
	type Tree = { "sources": { "source": string; "tab"?: string }[]; "openSpans": { "name"?: string; "tab"?: string }[] };
	const all = (await call("get_tree_state")).value as Tree;

	assert.deepEqual(all.sources.filter((row) => row.source === "root").map((row) => row.tab ?? "").sort((left, right) => left.localeCompare(right)), ["t1", "t2"], "one `root` per tab, not one merged");

	const one = (await call("get_tree_state", { "tab": "t1" })).value as Tree;

	assert.deepEqual([...new Set(one.sources.map((row) => row.tab))], ["t1"]);
	assert.deepEqual(one.openSpans.map((span) => [span.name, span.tab]), [["load", "t1"]]);
});

test("wait_for with a tab waits for that tab's record, not the other's", async () => {
	const waiting = call("wait_for", { "textIncludes": "ping", "tab": "t2", "timeoutMs": 5000 });

	await new Promise((resolve) => { setTimeout(resolve, 100); });

	for (const tab of ["t1", "t2"]) {
		roots.get(tab)!.publish("$sys.log.root", { "kind": "log", "level": "info", "message": "ping from " + tab, "context": { "source": "root" }, "time": Date.now(), "depth": 0 });
	}

	const { value } = await waiting;

	assert.deepEqual([(value as Row).message, (value as Row).tab], ["ping from t2", "t2"]);
});

test("query_metrics summarizes one tab's metrics plane — two tabs' same-named sources kept apart", async () => {
	type Series = { "series": string; "latest": number; "samples": number; "points"?: [number, number][] };
	const ambiguous = await call("query_metrics");

	assert.equal(ambiguous.isError, true, "several tabs: which?");

	// Each tab's root samples its gauges once a second; here, a few readings each (until debug-mcp's interest reaches them).
	const series = await until("both tabs' samples", async () => {
		for (const [tab, root] of roots) {
			root.publish("$sys.metrics.root", { "source": "root", "t": Date.now(), "values": { "memory.total": tab === "t1" ? 100 : 200, "spans.sw/cdn.errors": 0 } });
		}

		const [t1, t2] = await Promise.all(["t1", "t2"].map(async (tab) => (await call("query_metrics", { "tab": tab, "match": "memory", "points": 5 })).value as Series[]));

		return Array.isArray(t1) && Array.isArray(t2) && t1[0]?.samples >= 2 && t2[0]?.samples >= 2 ? { t1, t2 } : undefined;
	});

	assert.deepEqual(series.t1.map((row) => [row.series, row.latest]), [["root:memory.total", 100]]);
	assert.deepEqual(series.t2.map((row) => [row.series, row.latest]), [["root:memory.total", 200]]);
	assert.ok((series.t1[0].points?.length ?? 0) >= 2, "points when asked");
	assert.deepEqual(((await call("query_metrics", { "tab": "t1", "match": "spans" })).value as Series[]).map((row) => row.series), ["root:spans.sw/cdn.errors"]);
});

test("once a tab goes, its architecture goes with it, and the one left needs no `tab`", async () => {
	sockets.get("t1")?.close();
	await until("one tab left", async () => (debugMcp.linkCount() === 1 ? true : undefined));

	const { isError, value } = await architecture();

	assert.notEqual(isError, true, JSON.stringify(value));
	assert.ok(value.nodes.some((node) => node.id === "worker-b"));
	assert.equal(debugMcp.archOf("t1"), undefined);
	// Its records stay, still filed under it.
	assert.deepEqual((await queryLogs({ "tab": "t1", "textIncludes": "hello from" })).map((row) => row.message), ["hello from t1"]);
});
