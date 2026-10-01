/**
 * The editor tab's own MCP tools (page-tools.ts) end to end: an MCP client → debug-mcp → a stand-in editor tab serving
 * them as page tools, over its root, to stand-ins for what its tree answers (the pod's debug.*, each session's own
 * debug.session.<id>.*, the shell's preview.cdp).
 *
 *   node --import tsx --test test/page-tools.test.mjs
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createHub, serve, websocketTransport } from "@brianjenkins94/hub";
import { until } from "@brianjenkins94/util/until";

import { createDebugMcp } from "../../debug-mcp/src/server.ts";
import { connectTestClient } from "../../debug-mcp/src/testing.ts";
import { OBSERVABILITY_PROTOCOL, servePageToolSet, TAB_DISCOVER, TAB_HERE } from "../../observability/src/index.ts";
import { editorPageTools } from "../page-tools.ts";

let debugMcp;
let mcp;
let socket;
let sessions = [{ "session": "s1", "name": "debug index.ts", "program": "/workspace/src/index.ts", "state": "stopped" }];
const stepped = [];

before(async () => {
	debugMcp = createDebugMcp({ "port": 0 });

	const port = await debugMcp.whenListening;
	const root = createHub({ "id": "root" });

	serve(root, "debug.sessions", () => sessions);
	serve(root, "debug.start", (args) => ({ "session": "s1", "state": "stopped", "reason": "breakpoint", "line": args.breakpoints[0], "output": [] }));
	serve(root, "debug.session.s1.step", (args) => {
		stepped.push(args.action);

		return { "session": "s1", "state": "stopped", "reason": "step", "line": 4, "output": ["hi"] };
	});
	serve(root, "debug.session.s1.state", () => ({ "session": "s1", "state": "stopped", "line": 4, "output": [] }));
	// The shell's CDP endpoint: a raw reply, with the command's id.
	serve(root, "preview.cdp", (args) => {
		const command = JSON.parse(args.message);

		return JSON.stringify(command.method === "Nope.nope"
			? { "id": command.id, "error": { "code": -32601, "message": "unknown method" } }
			: { "id": command.id, "result": { ...args.window === undefined ? { "port": args.port } : { "window": args.window }, "method": command.method } });
	});
	servePageToolSet(root, "t1", editorPageTools(root));
	// (What answerTabDiscovery says in a page.)
	root.subscribe(TAB_DISCOVER, (data) => {
		root.publish(TAB_HERE, { "query": data.query, "tab": "t1", "url": "http://localhost:5173/", "title": "editor", "visible": true, "focused": true, "protocol": OBSERVABILITY_PROTOCOL });
	});

	socket = new WebSocket("ws://localhost:" + port);
	await new Promise((resolve) => { socket.addEventListener("open", resolve, { "once": true }); });
	await root.link(websocketTransport(socket)).ready;
	mcp = await connectTestClient(debugMcp);
});

after(async () => {
	socket?.close();
	await mcp?.close();
	await debugMcp?.close();
});

async function call(name, args = {}) {
	return mcp.call(name, args);
}

test("the editor's tools are listed while its tab is connected", async () => {
	const names = await until("the tab's tools", async () => {
		const listed = (await mcp.client.listTools()).tools.map((tool) => tool.name);

		return listed.includes("debug_start") ? listed : undefined;
	});

	for (const name of ["debug_start", "debug_sessions", "debug_step", "debug_state", "debug_breakpoints", "debug_stop", "provoke_transform", "preview_cdp"]) {
		assert.ok(names.includes(name), name + " in " + names.join(", "));
	}
});

test("debug_start runs in the tab, and debug_step finds the only session without being told", async () => {
	assert.equal((await call("debug_start", { "program": "src/index.ts", "breakpoints": [3] })).value.line, 3);

	const step = await call("debug_step", { "action": "next" });

	assert.equal(step.value.line, 4);
	assert.deepEqual(stepped, ["next"]);
});

test("with several sessions, debug_state asks which one instead of guessing", async () => {
	sessions = [...sessions, { "session": "s2", "name": "debug b.ts", "program": "/workspace/src/b.ts", "state": "running" }];

	const answer = await call("debug_state");

	assert.equal(answer.isError, true);
	assert.match(String(answer.value), /several debug sessions — pass one: s1 .*s2/u);
	assert.equal((await call("debug_state", { "session": "s1" })).value.line, 4);
	sessions = sessions.slice(0, 1);
});

test("an unknown session fails fast instead of hanging", async () => {
	const started = Date.now();
	const answer = await call("debug_state", { "session": "nope" });

	assert.equal(answer.isError, true);
	assert.ok(Date.now() - started < 4500, "failed after " + (Date.now() - started) + "ms");
});

test("preview_cdp sends one CDP command to a preview's page and returns its result, or its error", async () => {
	assert.deepEqual((await call("preview_cdp", { "method": "DOM.getDocument" })).value, { "port": 5173, "method": "DOM.getDocument" });
	assert.deepEqual((await call("preview_cdp", { "method": "DOM.getDocument", "window": "5173~2" })).value, { "window": "5173~2", "method": "DOM.getDocument" });

	const failed = await call("preview_cdp", { "method": "Nope.nope" });

	assert.equal(failed.isError, true);
	assert.match(String(failed.value), /Nope\.nope: unknown method/u);
});
