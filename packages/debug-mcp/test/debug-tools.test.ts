/**
 * The debugger tools end to end: an MCP client → debug-mcp → a WebSocket → a stand-in editor tab whose hub serves the
 * worker-pod's debug RPCs. Runs under tsx (`node --import tsx`), since server.ts imports the hub's TS source from
 * node_modules, which node won't type-strip.
 */
import type { AddressInfo } from "node:net";
import * as assert from "node:assert/strict";
import { createServer } from "node:net";

import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createHub, serve, websocketTransport } from "@brianjenkins94/hub";

import { createMcpServer } from "../src/mcp.ts";
import { createDebugMcp } from "../src/server.ts";

let debugMcp: ReturnType<typeof createDebugMcp>;
let client: Client;
let socket: WebSocket;
const page = createHub({ "id": "root" });
const stepped: { "session": string; "action": string }[] = [];
let sessions = [{ "session": "s1", "name": "debug index.ts", "program": "/workspace/src/index.ts", "state": "stopped" }];

before(async () => {
	const port = await freePort();

	debugMcp = createDebugMcp({ "port": port });
	await debugMcp.whenListening;

	// The editor tab's side: the pod's calls, and one stopped session.
	serve(page, "debug.sessions", () => sessions);
	serve(page, "debug.start", (args) => ({ "session": "s1", "state": "stopped", "reason": "breakpoint", "line": (args as { "breakpoints": number[] }).breakpoints[0], "output": [] }));
	serve(page, "debug.session.s1.step", (args) => {
		stepped.push({ "session": "s1", "action": (args as { "action": string }).action });

		return { "session": "s1", "state": "stopped", "reason": "step", "line": 4, "code": "return a + b;", "locals": [{ "name": "a", "value": "1", "type": "number" }], "output": ["hi"] };
	});
	serve(page, "debug.session.s1.state", () => ({ "session": "s1", "state": "stopped", "line": 4, "output": [] }));

	socket = new WebSocket("ws://localhost:" + port);
	await new Promise((resolve) => { socket.addEventListener("open", resolve, { "once": true }); });
	page.link(websocketTransport(socket as unknown as Parameters<typeof websocketTransport>[0]));

	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

	await createMcpServer(debugMcp).connect(serverSide);
	client = new Client({ "name": "test", "version": "0.0.0" });
	await client.connect(clientSide);
	await new Promise((resolve) => { setTimeout(resolve, 100); }); // interest settles across the socket
});

after(async () => {
	socket.close();
	await client.close();
	await debugMcp.close();
});

/** A port nothing is listening on (debug-mcp doesn't report the one it bound). */
function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const probe = createServer().listen(0, () => {
			const { port } = probe.address() as AddressInfo;

			probe.close(() => { resolve(port); });
		});
	});
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ "isError"?: boolean; "value": unknown }> {
	const result = await client.callTool({ "name": name, "arguments": args }) as { "isError"?: boolean; "content": { "type": string; "text": string }[] };
	const text = result.content[0]?.text ?? "";

	return { "isError": result.isError, "value": ((): unknown => { try { return JSON.parse(text); } catch { return text; } })() };
}

test("the debugger tools are listed", async () => {
	const names = (await client.listTools()).tools.map((tool) => tool.name);

	for (const name of ["debug_start", "debug_sessions", "debug_step", "debug_state", "debug_breakpoints", "debug_stop"]) {
		assert.ok(names.includes(name), name);
	}
});

test("debug_step without a session acts on the only live one and returns where it stopped", async () => {
	const { isError, value } = await call("debug_step", { "action": "next" });

	assert.notEqual(isError, true, JSON.stringify(value));
	assert.deepEqual(stepped.at(-1), { "session": "s1", "action": "next" });
	assert.equal((value as { "line": number }).line, 4);
	assert.equal((value as { "code": string }).code, "return a + b;");
});

test("debug_start forwards the program and breakpoints and returns the first stop", async () => {
	const { value } = await call("debug_start", { "program": "src/index.ts", "breakpoints": [7] });

	assert.equal((value as { "line": number }).line, 7);
});

test("with several sessions, debug_state asks which one instead of guessing", async () => {
	sessions = [...sessions, { "session": "s2", "name": "debug other.ts", "program": "/workspace/other.ts", "state": "running" }];

	const { isError, value } = await call("debug_state");

	assert.equal(isError, true);
	assert.match(String(value), /several debug sessions.*s1.*s2/u);
	assert.equal(((await call("debug_state", { "session": "s1" })).value as { "line": number }).line, 4);
});

test("an unknown session fails fast instead of hanging", async () => {
	const started = Date.now();
	const { isError, value } = await call("debug_step", { "action": "next", "session": "nope" });

	assert.equal(isError, true);
	assert.match(String(value), /no responder/u);
	assert.ok(Date.now() - started < 5000);
});
