/**
 * Payload capture from debug-mcp: off by default; `capture_payloads` turns it on in every connected tab (and in one that
 * links later), and get_architecture's channel detail then shows what each sampled message carried.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { TestClient } from "../src/testing.ts";
import * as assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHub, portTransport, websocketTransport } from "@brianjenkins94/hub";
import { until } from "@brianjenkins94/util/until";

import { createArchReporter } from "../../observability/src/arch.ts";
import { TAB_DISCOVER, TAB_HERE } from "../../observability/src/tabs.ts";
import { createDebugMcp } from "../src/server.ts";
import { connectTestClient } from "../src/testing.ts";

let debugMcp: ReturnType<typeof createDebugMcp>;
let mcp: TestClient;
let socket: WebSocket;
let root: Hub;
let worker: Hub;
const disposers: (() => void)[] = [];

before(async () => {
	debugMcp = createDebugMcp({ "port": 0 });

	const port = await debugMcp.whenListening;
	const channel = new MessageChannel();

	root = createHub({ "id": "root" });
	worker = createHub({ "id": "worker" });
	root.link(portTransport(channel.port1));
	worker.link(portTransport(channel.port2));
	worker.subscribe("game.move", () => undefined);

	for (const hub of [root, worker]) {
		disposers.push(createArchReporter(hub).dispose);
	}

	root.subscribe(TAB_DISCOVER, (data) => {
		root.publish(TAB_HERE, { "query": (data as { "query": string }).query, "tab": "t1", "url": "http://localhost/", "title": "t1", "visible": true, "focused": true });
	});
	socket = new WebSocket("ws://localhost:" + port);
	await new Promise((resolve) => { socket.addEventListener("open", resolve, { "once": true }); });
	await root.link(websocketTransport(socket as unknown as Parameters<typeof websocketTransport>[0])).ready;
	mcp = await connectTestClient(debugMcp);
	disposers.push(() => { channel.port1.close(); channel.port2.close(); });
});

after(async () => {
	disposers.forEach((dispose) => { dispose(); });
	socket?.close();
	await mcp?.close();
	await debugMcp?.close();
});

async function recentPayloads(): Promise<unknown[]> {
	const { value } = await mcp.call("get_architecture", { "channel": "root|worker" });

	return ((value as { "recent": { "label": string; "payload"?: string }[] }[])[0]?.recent ?? []).filter((sample) => sample.label === "game.move").map((sample) => sample.payload);
}

test("capture is off until asked for, then a channel's recent traffic shows what it carried", async () => {
	root.publish("game.move", { "x": 1 });
	await until("the first move sampled", async () => (await recentPayloads()).length >= 1, { "timeoutMs": 5000 });
	assert.deepEqual(await recentPayloads(), [undefined], "off by default");

	assert.deepEqual((await mcp.call("capture_payloads", { "on": true })).value, { "capturing": true });
	await new Promise((resolve) => { setTimeout(resolve, 100); });
	root.publish("game.move", { "x": 2 });

	const payloads = await until("the captured move", async () => {
		const found = await recentPayloads();

		return found.length >= 2 ? found : undefined;
	}, { "timeoutMs": 5000 });

	assert.deepEqual(payloads, [undefined, "{\"x\":2}"]);
	assert.deepEqual((await mcp.call("capture_payloads", { "on": false })).value, { "capturing": false });
});
