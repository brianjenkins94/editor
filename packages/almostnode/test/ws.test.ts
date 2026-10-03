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

/** Wait until `ready()` holds (each step takes a turn or two of the event loop — however long a loaded machine makes them). */
async function until(ready: () => boolean, what: string): Promise<void> {
	for (const started = Date.now(); !ready(); await new Promise((resolve) => { setTimeout(resolve, 5); })) {
		if (Date.now() - started > 5000) {
			throw new Error("timed out waiting for " + what);
		}
	}
}

/** A few turns of the event loop, for what should NOT happen. */
const turns = async (): Promise<void> => new Promise((resolve) => { setTimeout(resolve, 50); });

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
	await until(() => client.readyState === WebSocket.OPEN, "the client to open");
	assert.equal(server.clients.size, 1);

	client.send("ping");
	await until(() => heardByClient.length > 0, "the server's reply");

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
	await until(() => client.readyState === WebSocket.OPEN && serverSide !== undefined, "the connection");
	client.close(1000, "done");
	await until(() => serverHeardClose && clientHeardClose, "both ends to close");

	assert.ok(serverHeardClose, "the server's socket closed");
	assert.equal(server.clients.size, 0, "and left the server's clients");

	// The other way: the server shuts down, its clients close.
	const second = new WebSocket("/close");
	let secondClosed = false;

	second.on("close", () => { secondClosed = true; });
	await until(() => second.readyState === WebSocket.OPEN, "the second client to open");
	server.close();
	await until(() => secondClosed, "the second client to close");

	assert.ok(secondClosed);
	assert.ok(serverSide !== undefined && clientHeardClose);
});

test("a client with no server here opens on its own, and a noServer server takes no connections by path", async () => {
	const lonely = new WebSocket("/nobody-listens");

	await until(() => lonely.readyState === WebSocket.OPEN, "the lonely client to open");
	assert.doesNotThrow(() => { lonely.send("into the void"); });

	const upgradeOnly = new WebSocketServer({ "noServer": true, "path": "/upgrade-only" });
	let connected = false;

	upgradeOnly.on("connection", () => { connected = true; });
	const client = new WebSocket("/upgrade-only");

	await until(() => client.readyState === WebSocket.OPEN, "the client to open");
	await turns();
	assert.equal(connected, false);
	client.close();
	upgradeOnly.close();
});
