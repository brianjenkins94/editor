/**
 * The page and debugger tools end to end: an MCP client → debug-mcp → WebSockets → stand-in editor tabs, each serving
 * what the real tab's root does (its tools under its own id, tab discovery, the pod's debug calls forwarded as
 * `debug.*.<tab>`, and a session's own `debug.session.<id>.*`). Runs under tsx (`node --import tsx`), since server.ts
 * imports the hub's TS source from node_modules, which node won't type-strip.
 */
import type { AddressInfo } from "node:net";
import * as assert from "node:assert/strict";
import { createServer } from "node:net";

import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Hub } from "@brianjenkins94/hub";
import { createHub, serve, websocketTransport } from "@brianjenkins94/hub";

import { TAB_DISCOVER, TAB_HERE } from "../../observability/src/tabs.ts";
import { createMcpServer } from "../src/mcp.ts";
import { createDebugMcp } from "../src/server.ts";

let debugMcp: ReturnType<typeof createDebugMcp>;
let port: number;
let client: Client;
const sockets: WebSocket[] = [];
const stepped: { "session": string; "action": string }[] = [];
const started: string[] = [];
const evaluated: string[] = [];
let sessions = [{ "session": "s1", "name": "debug index.ts", "program": "/workspace/src/index.ts", "state": "stopped" }];

/** A stand-in editor tab `tab`: what its root serves to debug-mcp. */
function tabHub(tab: string): Hub {
	const root = createHub({ "id": "root" });

	root.subscribe(TAB_DISCOVER, (data) => {
		root.publish(TAB_HERE, { "query": (data as { "query": string }).query, "tab": tab, "url": "http://localhost:5173/", "title": "editor " + tab, "visible": true, "focused": tab === "t1" });
	});
	serve(root, "page_eval." + tab, () => {
		evaluated.push(tab);

		return tab;
	});
	serve(root, "debug.sessions." + tab, () => (tab === "t1" ? sessions : []));
	serve(root, "debug.start." + tab, (args) => {
		started.push(tab);

		return { "session": "s1", "state": "stopped", "reason": "breakpoint", "line": (args as { "breakpoints": number[] }).breakpoints[0], "output": [] };
	});

	if (tab === "t1") {
		serve(root, "debug.session.s1.step", (args) => {
			stepped.push({ "session": "s1", "action": (args as { "action": string }).action });

			return { "session": "s1", "state": "stopped", "reason": "step", "line": 4, "code": "return a + b;", "locals": [{ "name": "a", "value": "1", "type": "number" }], "output": ["hi"] };
		});
		serve(root, "debug.session.s1.state", () => ({ "session": "s1", "state": "stopped", "line": 4, "output": [] }));
	}

	return root;
}

/** Open tab `tab`'s WebSocket to debug-mcp. */
async function connectTab(tab: string): Promise<void> {
	const socket = new WebSocket("ws://localhost:" + port);

	await new Promise((resolve) => { socket.addEventListener("open", resolve, { "once": true }); });
	tabHub(tab).link(websocketTransport(socket as unknown as Parameters<typeof websocketTransport>[0]));
	sockets.push(socket);
	await new Promise((resolve) => { setTimeout(resolve, 150); }); // interest settles across the socket
}

before(async () => {
	port = await freePort();
	debugMcp = createDebugMcp({ "port": port });
	await debugMcp.whenListening;
	await connectTab("t1");

	const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();

	await createMcpServer(debugMcp).connect(serverSide);
	client = new Client({ "name": "test", "version": "0.0.0" });
	await client.connect(clientSide);
});

after(async () => {
	sockets.forEach((socket) => { socket.close(); });
	await client.close();
	await debugMcp.close();
});

/** A port nothing is listening on (debug-mcp doesn't report the one it bound). */
function freePort(): Promise<number> {
	return new Promise((resolve) => {
		const probe = createServer().listen(0, () => {
			const { port: free } = probe.address() as AddressInfo;

			probe.close(() => { resolve(free); });
		});
	});
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<{ "isError"?: boolean; "value": unknown }> {
	const result = await client.callTool({ "name": name, "arguments": args }) as { "isError"?: boolean; "content": { "type": string; "text": string }[] };
	const text = result.content[0]?.text ?? "";

	return { "isError": result.isError, "value": ((): unknown => { try { return JSON.parse(text); } catch { return text; } })() };
}

test("the page and debugger tools are listed", async () => {
	const names = (await client.listTools()).tools.map((tool) => tool.name);

	for (const name of ["list_tabs", "page_eval", "debug_start", "debug_sessions", "debug_step", "debug_state", "debug_breakpoints", "debug_stop"]) {
		assert.ok(names.includes(name), name);
	}
});

test("with one tab connected, tools act on it without being told which", async () => {
	assert.deepEqual(((await call("list_tabs")).value as { "tab": string }[]).map((entry) => entry.tab), ["t1"]);
	assert.equal((await call("page_eval", { "expression": "1" })).value, "t1");

	const { isError, value } = await call("debug_step", { "action": "next" });

	assert.notEqual(isError, true, JSON.stringify(value));
	assert.deepEqual(stepped.at(-1), { "session": "s1", "action": "next" });
	assert.equal((value as { "code": string }).code, "return a + b;");
	assert.equal(((await call("debug_start", { "program": "src/index.ts", "breakpoints": [7] })).value as { "line": number }).line, 7);
});

test("with several sessions, debug_state asks which one instead of guessing", async () => {
	sessions = [...sessions, { "session": "s2", "name": "debug other.ts", "program": "/workspace/other.ts", "state": "running" }];

	const { isError, value } = await call("debug_state");

	sessions = sessions.slice(0, 1);
	assert.equal(isError, true);
	assert.match(String(value), /several debug sessions.*s1.*s2/u);
	assert.equal(((await call("debug_state", { "session": "s1" })).value as { "line": number }).line, 4);
});

test("an unknown session fails fast instead of hanging", async () => {
	const begun = Date.now();
	const { isError, value } = await call("debug_step", { "action": "next", "session": "nope" });

	assert.equal(isError, true);
	assert.match(String(value), /no responder/u);
	assert.ok(Date.now() - begun < 5000);
});

test("with two tabs connected, a call runs in the tab it names and never in both", async () => {
	await connectTab("t2");

	const tabs = ((await call("list_tabs")).value as { "tab": string }[]).map((entry) => entry.tab).sort();

	assert.deepEqual(tabs, ["t1", "t2"]);

	// Unnamed: refuse, and say which tabs there are.
	started.length = 0;
	evaluated.length = 0;

	const unnamed = await call("debug_start", { "program": "src/index.ts", "breakpoints": [3] });

	assert.equal(unnamed.isError, true);
	assert.match(String(unnamed.value), /several editor tabs.*t1.*t2/u);
	assert.deepEqual(started, []);

	// Named: exactly that tab.
	await call("debug_start", { "program": "src/index.ts", "breakpoints": [3], "tab": "t2" });
	assert.deepEqual(started, ["t2"]);
	assert.equal((await call("page_eval", { "expression": "1", "tab": "t1" })).value, "t1");
	assert.deepEqual(evaluated, ["t1"]);

	// A session's own calls still route to the tab that owns it, with no tab named.
	assert.equal(((await call("debug_state", { "session": "s1" })).value as { "line": number }).line, 4);
});
