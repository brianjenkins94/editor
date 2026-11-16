/**
 * The terminal's runs (workbench/node-runner.ts): a run asked for before the debugger listens — typed as the editor
 * starts, before the bridge subscribes — is launched once it does, rather than lost with the run waiting for ever.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createHub } from "@brianjenkins94/hub";

import { createNodeRunner } from "../workbench/node-runner.ts";

test("a run asked for before the debugger listens is launched once it does, not lost", async () => {
	const hub = createHub({ "id": "workbench" });
	const runner = createNodeRunner(hub);
	const ran = runner.debug("/workspace/a.ts", "/workspace", {}, {
		"runId": "early",
		"onOutput": () => undefined
	});
	const launched = [];

	// (the bridge's subscription, arriving after the run was asked for)
	await new Promise((resolve) => { setTimeout(resolve, 50); });
	hub.subscribe("debug.launch", (data) => {
		launched.push(data.runId);
		hub.publish(`node.exit.${data.runId}`, { "exitCode": 3 });
	});

	assert.deepEqual(await ran, { "attached": true, "exitCode": 3 });
	assert.deepEqual(launched, ["early"]);
});

test("a run stopped while it waits for the debugger is never launched", async () => {
	const hub = createHub({ "id": "workbench" });
	const runner = createNodeRunner(hub);
	const controller = new AbortController();
	const ran = runner.debug("/workspace/a.ts", "/workspace", {}, {
		"runId": "stopped",
		"onOutput": () => undefined,
		"signal": controller.signal
	});
	const launched = [];

	controller.abort();
	hub.subscribe("debug.launch", (data) => { launched.push(data.runId); });

	assert.deepEqual(await ran, { "attached": true, "exitCode": 130 });
	await new Promise((resolve) => { setTimeout(resolve, 50); });
	assert.deepEqual(launched, []);
});
