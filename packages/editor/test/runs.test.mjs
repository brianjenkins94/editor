// What's running (workbench/runs.ts): every run registered as it starts and marked as it ends — running ones first, newest
// first, then the ended — a task that starts listening a service, stopping one by its id over the hub (`runs.stop`,
// agents' runs_stop).
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { createHub, createRpcClient } from "@brianjenkins94/hub";
import { createRunRegistry } from "../workbench/runs.ts";

/** A registry on a hub of its own, and a client asking it. */
function registry() {
	const hub = createHub({ "id": "workbench" });

	return { "runs": createRunRegistry(hub), "rpc": createRpcClient(hub) };
}

const run = (title) => ({ "title": title, "kind": "task", "cwd": "/workspace", "origin": { "terminal": 1 } });

test("running ones first, newest first, then the ended; a run ends exited, failed or stopped", async () => {
	const { runs } = registry();
	const first = runs.start(run("node a.ts"), () => undefined);

	await new Promise((resolve) => {
		setTimeout(resolve, 2);
	});

	const second = runs.start(run("node b.ts"), () => undefined);
	const third = runs.start(run("node c.ts"), () => undefined);

	first.end(0);
	second.end(1);
	third.end(0, true);
	third.end(0); // (once)

	const listed = runs.list();

	assert.deepEqual(listed.map((each) => [each.title, each.state]), [["node c.ts", "stopped"], ["node b.ts", "failed"], ["node a.ts", "exited"]]);
	assert.equal(listed[1].exitCode, 1);
});

test("a task that starts listening is a service, found as the running one a second copy would be", () => {
	const { runs } = registry();
	const dev = runs.start(run("npm run dev"), () => undefined);

	assert.equal(runs.runningService(() => true), undefined);
	dev.update({ "kind": "service", "port": 5173 });
	assert.equal(runs.runningService((each) => each.cwd === "/workspace")?.port, 5173);

	const ended = [];
	const off = runs.onEnd((each) => {
		ended.push(each.title);
	});

	dev.end(0, true);
	off();
	assert.deepEqual(ended, ["npm run dev"]);
	assert.equal(runs.runningService(() => true), undefined);
});

test("over the hub: the list, and a run stopped by its id (runs_list, runs_stop)", async () => {
	const { runs, rpc } = registry();
	let stopped = false;
	const script = runs.start(run("node serve.ts"), () => {
		stopped = true;
	});

	assert.deepEqual((await rpc.request("runs.list", undefined, { "timeoutMs": 5000 })).map((each) => each.id), [script.id]);
	assert.equal(await rpc.request("runs.stop", { "id": "nope" }, { "timeoutMs": 5000 }), false);
	assert.equal(await rpc.request("runs.stop", { "id": script.id }, { "timeoutMs": 5000 }), true);
	assert.equal(stopped, true);
});
