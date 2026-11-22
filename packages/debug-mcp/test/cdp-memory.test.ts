/**
 * Memory by realm through the browser's DevTools endpoint (cdp-memory.ts): a real Chromium with a page that runs a
 * worker, linked as a stand-in tab; and, with no endpoint and no gauge reading memory, metrics_query saying so.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Server } from "node:http";
import * as assert from "node:assert/strict";

import { createServer } from "node:http";
import { after, before, test } from "node:test";
import { launchChromium } from "@brianjenkins94/util/playwright/chromium";
import { until } from "@brianjenkins94/util/until";
import { createHub, websocketTransport } from "@brianjenkins94/hub";

import { TAB_DISCOVER, TAB_HERE } from "../../observability/src/tabs.ts";
import { realmOf, sampleOf } from "../src/cdp-memory.ts";
import { createDebugMcp } from "../src/server.ts";
import { connectTestClient } from "../src/testing.ts";

const DEVTOOLS_PORT = 9337;

let server: Server;
let address: string;
let browser: Awaited<ReturnType<typeof launchChromium>>;
const sockets: WebSocket[] = [];

/** A stand-in tab linked to `port`, saying it's at `url`. */
async function linkTab(port: number, tab: string, url: string): Promise<Hub> {
	const root = createHub({ "id": "root" });

	root.subscribe(TAB_DISCOVER, (data) => {
		root.publish(TAB_HERE, { "query": (data as { "query": string }).query, "tab": tab, "url": url, "title": tab, "visible": true, "focused": true, "protocol": 5 });
	});

	const socket = new WebSocket("ws://localhost:" + String(port));

	sockets.push(socket);
	await new Promise((resolve) => { socket.addEventListener("open", resolve, { "once": true }); });
	await root.link(websocketTransport(socket as unknown as Parameters<typeof websocketTransport>[0])).ready;

	return root;
}

before(async () => {
	// A page that starts a worker, named, holding a 32 MB ArrayBuffer (backing store, not heap).
	server = createServer((request, response) => {
		if (request.url === "/worker.js") {
			response.writeHead(200, { "content-type": "text/javascript" }).end("self.held = new ArrayBuffer(32 * 1048576); new Uint8Array(self.held).fill(1); setInterval(() => {}, 1000);");

			return;
		}

		response.writeHead(200, { "content-type": "text/html" }).end("<!doctype html><title>memory</title><script>new Worker('/worker.js', { name: 'holder' });</script>");
	});
	await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
	address = `http://127.0.0.1:${String((server.address() as { "port": number }).port)}/`;
	browser = await launchChromium({ "args": [`--remote-debugging-port=${String(DEVTOOLS_PORT)}`] });
	await (await browser.newPage()).goto(address);
});

after(async () => {
	sockets.forEach((socket) => { socket.close(); });
	await browser.close();
	server.close();
});

test("a realm is named by what it is: the page, a worker by its name or script, a frame by its address", () => {
	assert.equal(realmOf({ "targetId": "1", "type": "page", "url": "http://x/", "title": "Editor" }), "page");
	assert.equal(realmOf({ "targetId": "2", "type": "worker", "url": "http://x/w.js", "title": "eslint" }), "eslint");
	assert.equal(realmOf({ "targetId": "3", "type": "worker", "url": "http://x/assets/bootstrap.js?v=1#/assets/ts.worker.js", "title": "http://x/assets/bootstrap.js" }), "ts.worker.js");
	assert.equal(realmOf({ "targetId": "4", "type": "iframe", "url": "https://other/frame.html", "title": "https://other/frame.html" }), "frame:frame.html");

	const sample = sampleOf([
		{ "target": { "targetId": "w1", "type": "worker", "url": "http://x/a.js", "title": "same" }, "used": 1048576, "backing": 0 },
		{ "target": { "targetId": "w2", "type": "worker", "url": "http://x/b.js", "title": "same" }, "used": 2 * 1048576, "backing": 1048576 },
		{ "target": { "targetId": "p", "type": "page", "url": "http://x/", "title": "x" }, "used": 4 * 1048576, "backing": 0 }
	], 1);

	assert.deepEqual(sample.values, { "heap.page": 4, "backing.page": 0, "heap.same": 1, "backing.same": 0, "heap.same~2": 2, "backing.same~2": 1, "heap.total": 7, "backing.total": 1 });
});

test("with a DevTools endpoint, each realm of a linked tab's page is read: its heap and its backing stores", async () => {
	const debugMcp = createDebugMcp({ "port": 0, "cdp": `http://127.0.0.1:${String(DEVTOOLS_PORT)}` });
	const port = await debugMcp.whenListening;
	const { call, close } = await connectTestClient(debugMcp);

	try {
		await linkTab(port, "m1", address);
		await call("tabs_list");

		type Series = { "series": string; "latest": number };
		const series = await until("the worker's reading", async () => {
			const value = (await call("metrics_query", { "tab": "m1", "match": "cdp" })).value as Series[];

			return Array.isArray(value) && value.some((row) => row.series === "cdp:backing.holder") ? value : undefined;
		}, { "timeoutMs": 30_000 });
		const reading = (name: string): number => series.find((row) => row.series === name)?.latest ?? Number.NaN;

		assert.ok(reading("cdp:backing.holder") >= 32, `the worker's ArrayBuffer: ${JSON.stringify(series)}`);
		assert.ok(reading("cdp:heap.page") > 0, JSON.stringify(series));
		assert.ok(reading("cdp:heap.total") >= reading("cdp:heap.page") + reading("cdp:heap.holder") - 0.01, JSON.stringify(series));
		assert.equal(debugMcp.memoryVia(), `http://127.0.0.1:${String(DEVTOOLS_PORT)}`);
	} finally {
		await close();
		await debugMcp.close();
	}
});

test("with no endpoint and no gauge reading memory, metrics_query says why there's none", async () => {
	const debugMcp = createDebugMcp({ "port": 0, "cdp": false });
	const port = await debugMcp.whenListening;
	const { call, close } = await connectTestClient(debugMcp);

	try {
		const root = await linkTab(port, "m2", "http://localhost:5173/");

		await call("tabs_list");
		// (a tab reporting for a while — its first sample 40 s ago — with no memory gauge answering)
		await until("its samples", async () => {
			root.publish("$sys.metrics.root", { "source": "root", "t": Date.now() - 40_000, "values": { "frames": 60 } });
			root.publish("$sys.metrics.root", { "source": "root", "t": Date.now(), "values": { "frames": 60 } });

			return debugMcp.metricsOf("m2") === undefined ? undefined : true;
		});

		const rows = (await call("metrics_query", { "tab": "m2", "match": "memory" })).value as { "series": string; "said"?: string }[];

		assert.match(rows.find((row) => row.series === "memory")?.said ?? "", /no DevTools endpoint/u);
		assert.deepEqual(((await call("metrics_query", { "tab": "m2", "match": "frames" })).value as { "said"?: string }[]).filter((row) => row.said !== undefined), [], "only when memory was asked about");
	} finally {
		await close();
		await debugMcp.close();
	}
});
