/**
 * The editor tab's own MCP tools (tools/: a folder per family, util/mcp's own tools) end to end: an MCP client →
 * debug-mcp → a stand-in editor tab serving them as page tools, over its root, to stand-ins for what its tree answers (the pod's debug.*, each session's own
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
import code from "../app/tools/code/tools.ts";
import debug from "../app/tools/debug/tools.ts";
import editor from "../app/tools/editor/tools.ts";
import files from "../app/tools/files/tools.ts";
import git from "../app/tools/git/tools.ts";
import margin from "../app/tools/margin/tools.ts";
import { createToolHost, toPageTools } from "../app/tools/page-tools.ts";
import previews from "../app/tools/previews/tools.ts";
import rules from "../app/tools/rules/tools.ts";
import runs from "../app/tools/runs/tools.ts";
import terminal from "../app/tools/terminal/tools.ts";

/** Every family's tools, as the tab serves them (tools/index.ts finds the families; Node can't read its glob). */
const FAMILIES = [code, debug, editor, files, git, margin, previews, rules, runs, terminal];

let debugMcp;
let mcp;
let socket;
let windows = [{ "id": "preview:5173", "port": 5173, "window": 1 }];
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
			: { "id": command.id, "result": { "window": args.window, "method": command.method } });
	});
	serve(root, "preview.windows", () => windows);
	const host = createToolHost(root);

	servePageToolSet(root, "t1", toPageTools(FAMILIES.flatMap((family) => family(host))));
	// (What answerTabDiscovery says in a page.)
	root.subscribe(TAB_DISCOVER, (data) => {
		root.publish(TAB_HERE, { "query": data.query, "tab": "t1", "url": "http://localhost:5173/", "title": "editor", "visible": true, "focused": true, "protocol": OBSERVABILITY_PROTOCOL });
	});

	socket = new WebSocket("ws://localhost:" + port);
	await new Promise((resolve) => {
		socket.addEventListener("open", resolve, { "once": true });
	});
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

test("the editor's tools are listed while its tab is connected, each named <family>_<verb>", async () => {
	const names = await until("the tab's tools", async () => {
		const listed = (await mcp.client.listTools()).tools.map((tool) => tool.name);

		return listed.includes("debug_start") ? listed : undefined;
	});

	for (const name of ["debug_start", "debug_list", "debug_step", "debug_state", "debug_breakpoints", "debug_stop", "debug_explore", "margin_state", "editor_state", "editor_problems", "editor_notifications", "code_problems", "files_read", "files_write", "files_edit", "files_glob", "files_grep", "terminal_output", "runs_affected", "runs_tests", "git_status", "git_diff", "git_review", "git_commit", "git_discard", "git_branch", "git_checkout", "git_push", "rules_list", "previews_list", "previews_provoke", "previews_cdp", "previews_profile", "runs_list", "runs_stop", "runs_ledger"]) {
		assert.ok(names.includes(name), name + " in " + names.join(", "));
	}

	for (const name of names) {
		assert.match(name, /^[a-z]+_[a-z]+$/u, name);
	}
});

test("a tool's input survives the trip: zod in the tab, JSON Schema on the wire, zod in debug-mcp", async () => {
	const { tools } = await mcp.client.listTools();
	const edit = tools.find((tool) => tool.name === "files_edit").inputSchema;
	const step = tools.find((tool) => tool.name === "debug_step").inputSchema;

	assert.deepEqual([...edit.required].sort(), ["new", "old", "path"], "required stays required, optional stays optional");
	assert.equal(edit.properties.old.description, "The exact text to replace.");
	assert.deepEqual(step.properties.action.enum, ["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue"]);
	assert.ok("tab" in step.properties, "debug-mcp's own tab argument added");
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

test("previews_cdp sends one CDP command to a preview's page and returns its result, or its error", async () => {
	assert.deepEqual((await call("previews_cdp", { "method": "DOM.getDocument" })).value, { "window": "5173", "method": "DOM.getDocument" }, "the only window, without being told");
	assert.deepEqual((await call("previews_cdp", { "method": "DOM.getDocument", "window": "preview:5173~2" })).value, { "window": "5173~2", "method": "DOM.getDocument" }, "a window by the id previews_list gives");

	const failed = await call("previews_cdp", { "method": "Nope.nope" });

	assert.equal(failed.isError, true);
	assert.match(String(failed.value), /Nope\.nope: unknown method/u);
});

test("with several preview windows, a previews_* tool asks which one instead of guessing", async () => {
	windows = [...windows, { "id": "preview:5173~2", "port": 5173, "window": 2, "page": "http://localhost:5173/about" }];

	const answer = await call("previews_cdp", { "method": "DOM.getDocument" });

	assert.equal(answer.isError, true);
	assert.match(String(answer.value), /several preview windows are open — pass window: preview:5173; preview:5173~2 \(http:\/\/localhost:5173\/about\)/u);
	windows = windows.slice(0, 1);
});
