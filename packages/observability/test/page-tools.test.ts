import * as assert from "node:assert/strict";

import { test } from "node:test";
import { createHub, createRpcClient } from "@brianjenkins94/hub";
import { PAGE_TOOLS_CHANGED, servePageToolSet } from "../src/page-tools.ts";

test("a page serves its tools' manifest and each tool under its tab id, and announces them", async () => {
	const hub = createHub({ "id": "page" });
	const announced: unknown[] = [];

	hub.subscribe(PAGE_TOOLS_CHANGED, (data) => { announced.push(data); });

	const dispose = servePageToolSet(hub, "t1", [{
		"name": "game_status",
		"description": "The match's status.",
		"inputSchema": { "type": "object", "properties": { "client": { "type": "string" } } },
		"handler": (args) => ({ "asked": args["client"] ?? "all" })
	}]);
	const rpc = createRpcClient(hub);

	assert.deepEqual(announced, [{ "tab": "t1" }]);
	assert.deepEqual(await rpc.request("page_tools.t1", undefined, { "timeoutMs": 1000 }), [
		{ "name": "game_status", "description": "The match's status.", "inputSchema": { "type": "object", "properties": { "client": { "type": "string" } } } }
	]);
	assert.deepEqual(await rpc.request("tool.game_status.t1", { "client": "c1" }, { "timeoutMs": 1000 }), { "asked": "c1" });
	assert.deepEqual(await rpc.request("tool.game_status.t1", undefined, { "timeoutMs": 1000 }), { "asked": "all" }, "no arguments is {}");

	dispose();
	assert.deepEqual(announced, [{ "tab": "t1" }, { "tab": "t1" }], "withdrawing them is announced too");
	await assert.rejects(rpc.request("page_tools.t1", undefined, { "timeoutMs": 200, "waitForResponderMs": 100 }), /no responder/u);
});

test("a tool's error comes back as the call's error", async () => {
	const hub = createHub();

	servePageToolSet(hub, "t2", [{ "name": "broken", "description": "", "inputSchema": { "type": "object" }, "handler": () => { throw new Error("nope"); } }]);
	await assert.rejects(createRpcClient(hub).request("tool.broken.t2", {}, { "timeoutMs": 1000 }), /nope/u);
});

test("tool names must be safe MCP names and single subject tokens", () => {
	for (const name of ["Game", "game.status", "", "9lives", "game-status"]) {
		assert.throws(() => servePageToolSet(createHub(), "t3", [{ "name": name, "description": "", "inputSchema": {}, "handler": () => undefined }]), /page tool/u, name);
	}
});
