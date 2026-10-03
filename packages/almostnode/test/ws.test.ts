/**
 * The ws shim (shims/ws.ts): a script's WebSocketServer and its clients, in one realm, joined in memory — messages both
 * ways, and a close on either end reaching the other.
 */
import * as assert from "node:assert/strict";
import { register } from "node:module";
import { test } from "node:test";

// (almostnode's sources import each other without extensions: see extensionless.mjs.)
register("./extensionless.mjs", import.meta.url);

const { WebSocket, WebSocketServer } = await import("../shims/ws.ts");

type Socket = InstanceType<typeof WebSocket>;

const turn = (ms = 5): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms); });

test("a client connects to the server on its path, and each side's send reaches the other", async () => {
	const server = new WebSocketServer({ "path": "/socket" });
	const heardByServer: unknown[] = [];
	const heardByClient: unknown[] = [];

	server.on("connection", (socket: Socket) => {
		socket.on("message", (event: MessageEvent) => {
			heardByServer.push(event.data);
			socket.send("pong " + String(event.data));
		});
	});

	const client = new WebSocket("http://localhost:8080/socket");

	client.on("message", (event: MessageEvent) => { heardByClient.push(event.data); });
	await turn();
	assert.equal(client.readyState, WebSocket.OPEN);
	assert.equal(server.clients.size, 1);

	client.send("ping");
	await turn();

	assert.deepEqual(heardByServer, ["ping"]);
	assert.deepEqual(heardByClient, ["pong ping"]);
	server.close();
});

test("closing either end closes the other", async () => {
	const server = new WebSocketServer({ "path": "/close" });
	let serverSide: Socket | undefined;
	let serverHeardClose = false;

	server.on("connection", (socket: Socket) => {
		serverSide = socket;
		socket.on("close", () => { serverHeardClose = true; });
	});

	const client = new WebSocket("/close");
	let clientHeardClose = false;

	client.on("close", () => { clientHeardClose = true; });
	await turn();
	client.close(1000, "done");
	await turn();

	assert.ok(serverHeardClose, "the server's socket closed");
	assert.equal(server.clients.size, 0, "and left the server's clients");

	// The other way: the server shuts down, its clients close.
	const second = new WebSocket("/close");
	let secondClosed = false;

	second.on("close", () => { secondClosed = true; });
	await turn();
	server.close();
	await turn();

	assert.ok(secondClosed);
	assert.ok(serverSide !== undefined && clientHeardClose);
});

test("a client with no server here opens on its own, and a noServer server takes no connections by path", async () => {
	const lonely = new WebSocket("/nobody-listens");

	await turn();
	assert.equal(lonely.readyState, WebSocket.OPEN);
	assert.doesNotThrow(() => { lonely.send("into the void"); });

	const upgradeOnly = new WebSocketServer({ "noServer": true, "path": "/upgrade-only" });
	let connected = false;

	upgradeOnly.on("connection", () => { connected = true; });
	const client = new WebSocket("/upgrade-only");

	await turn();
	assert.equal(connected, false);
	client.close();
	upgradeOnly.close();
});
