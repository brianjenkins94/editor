/**
 * The editor tab's own MCP tools (tools/: a folder per family, util/mcp's own tools) end to end: an MCP client →
 * debug-mcp → a stand-in editor tab serving them as page tools, over its root, to stand-ins for what its tree answers
 * (the workbench's files.*).
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
import decisions from "../app/tools/decisions/tools.ts";
import editor from "../app/tools/editor/tools.ts";
import files from "../app/tools/files/tools.ts";
import git from "../app/tools/git/tools.ts";
import { createToolHost, toPageTools } from "../app/tools/page-tools.ts";
import runs from "../app/tools/runs/tools.ts";
import terminal from "../app/tools/terminal/tools.ts";

/** Every family's tools, as the tab serves them (tools/index.ts finds the families; Node can't read its glob). */
const FAMILIES = [decisions, editor, files, git, runs, terminal];

let debugMcp;
let mcp;
let socket;
const read = [];

before(async () => {
	debugMcp = createDebugMcp({ "port": 0 });

	const port = await debugMcp.whenListening;
	const root = createHub({ "id": "root" });

	serve(root, "files.read", (args) => {
		read.push(args.path);

		return { "path": args.path, "content": "1\thello" };
	});
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

		return listed.includes("files_read") ? listed : undefined;
	});

	for (const name of ["editor_state", "editor_trace", "editor_problems", "editor_notifications", "decisions_for", "files_read", "files_write", "files_edit", "files_replace", "files_glob", "files_grep", "files_delete", "terminal_output", "runs_affected", "runs_tests", "runs_list", "runs_stop", "git_status", "git_diff", "git_log", "git_show", "git_blame", "git_review", "git_commit", "git_discard", "git_branch", "git_checkout", "git_pull", "git_push"]) {
		assert.ok(names.includes(name), name + " in " + names.join(", "));
	}

	for (const name of names) {
		assert.match(name, /^[a-z]+_[a-z]+$/u, name);
	}
});

test("a tool's input survives the trip: zod in the tab, JSON Schema on the wire, zod in debug-mcp", async () => {
	const { tools } = await mcp.client.listTools();
	const edit = tools.find((tool) => tool.name === "files_edit").inputSchema;

	assert.deepEqual([...edit.required].sort(), ["new", "old", "path"], "required stays required, optional stays optional");
	assert.equal(edit.properties.old.description, "The exact text to replace.");
	assert.ok("tab" in edit.properties, "debug-mcp's own tab argument added");
});

test("a tool runs in the tab: files_read asks the tab's tree, and its answer comes back", async () => {
	assert.deepEqual((await call("files_read", { "path": "src/index.ts" })).value, { "path": "src/index.ts", "content": "1\thello" });
	assert.deepEqual(read, ["src/index.ts"]);
});
