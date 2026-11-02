/**
 * The ws shim (shims/ws.ts): a script's WebSocketServer and its clients, in one realm, joined in memory — messages both
 * ways, and a close on either end reaching the other.
 */
import * as assert from "node:assert/strict";
import { test } from "node:test";

// (almostnode's sources import each other without extensions: see extensionless.mjs.)
import "./extensionless.mjs";

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

test("a server on a port (any free one, for 0) is what the global WebSocket reaches at ws://localhost:<port> — EventTarget-style, as ws's sockets are, and every frame and the close seen", async () => {
	const { observeSockets, webSocketGlobal } = await import("../shims/ws.ts");
	const seen: unknown[] = [];

	observeSockets(({ port, path }) => {
		seen.push(["open", port, path]);

		return { "frame": (fromClient, data) => { seen.push([fromClient ? "client" : "server", data]); }, "closed": (code) => { seen.push(["closed", code]); } };
	});

	const server = new WebSocketServer({ "port": 0 });
	const port = await new Promise<number>((resolve) => { server.on("listening", () => { resolve(server.address()!.port); }); });
	let request: { "url": string; "headers": Record<string, string> } | undefined;

	assert.ok(port > 0, "bound to a port of its own");
	server.on("connection", (socket: Socket, upgrade: typeof request) => {
		request = upgrade;
		socket.addEventListener("message", (event) => { socket.send("pong " + String((event as MessageEvent).data)); });
	});

	// (the host's WebSocket, Node's: what it'd reach is the network — this one's here)
	const Global = webSocketGlobal(globalThis.WebSocket);
	const client = new Global(`ws://localhost:${port}/tools?tab=1`);
	const heard: unknown[] = [];

	client.addEventListener("message", (event) => { heard.push(event.data); });
	await new Promise((resolve) => { client.addEventListener("open", resolve, { "once": true }); });
	client.send("ping");
	await until(() => heard.length > 0, "the server's reply");
	client.close(1000);
	await until(() => seen.some(([what]) => what === "closed"), "the close to be seen");

	assert.deepEqual(heard, ["pong ping"]);
	assert.deepEqual(request, { "url": "/tools?tab=1", "headers": { "host": `localhost:${port}`, "upgrade": "websocket", "connection": "Upgrade" } }, "the upgrade request, as ws hands it over");
	assert.deepEqual(seen, [["open", port, "/tools"], ["client", "ping"], ["server", "pong ping"], ["closed", 1000]]);

	// The port's taken while it's bound; closed, it's free again.
	const second = new WebSocketServer({ "port": port });
	const error = await new Promise<Error & { "code"?: string }>((resolve) => { second.on("error", resolve); });

	assert.equal(error.code, "EADDRINUSE");
	server.close();
	observeSockets(undefined);

	const third = new WebSocketServer({ "port": port });

	await new Promise((resolve) => { third.on("listening", resolve); });
	third.close();
});
