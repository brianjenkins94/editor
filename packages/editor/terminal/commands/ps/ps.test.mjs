// `ps` and `kill` over a stand-in runs registry (runs.ts's shape), through a real just-bash.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Bash } from "just-bash/browser";

import { create as kill } from "../kill/kill.ts";
import { create as ps } from "./ps.ts";

function registry() {
	const runs = [
		{ "id": "aaaa1111-0000", "title": "npm run dev", "kind": "service", "cwd": "/workspace", "origin": { "terminal": 1 }, "state": "running", "startedAt": 2, "port": 5173 },
		{ "id": "aaaa2222-0000", "title": "node app.ts", "kind": "task", "cwd": "/workspace", "origin": { "terminal": 2 }, "state": "running", "startedAt": 1 },
		{ "id": "bbbb3333-0000", "title": "node old.ts", "kind": "task", "cwd": "/workspace", "origin": { "other": "Run" }, "state": "exited", "exitCode": 0, "startedAt": 0 }
	];
	const stopped = [];

	return { stopped, "runs": { "list": () => runs, "stop": (id) => { stopped.push(id); return true; } } };
}

test("ps: what's running, a short id each; -a adds what ended", async () => {
	const { runs } = registry();
	const bash = new Bash({ "customCommands": [ps({ "runner": { runs } })] });
	const running = (await bash.exec("ps")).stdout.split("\n");

	assert.match(running[0], /^ID\s+STATE\s+KIND\s+PORT\s+FROM\s+COMMAND$/u);
	assert.match(running[1], /^aaaa1111\s+running\s+service\s+5173\s+terminal 1\s+npm run dev$/u);
	assert.equal(running.filter(Boolean).length, 3, "the header and the two running");
	assert.match((await bash.exec("ps -a")).stdout, /bbbb3333\s+exited \(0\)\s+task\s+Run\s+node old\.ts/u);
});

test("kill: by any unique beginning of the id; an ambiguous or unknown one says so", async () => {
	const { runs, stopped } = registry();
	const bash = new Bash({ "customCommands": [kill({ "runner": { runs } })] });

	assert.equal((await bash.exec("kill -9 aaaa2")).exitCode, 0);
	assert.deepEqual(stopped, ["aaaa2222-0000"]);
	assert.match((await bash.exec("kill aaaa")).stderr, /more than one run/u);
	assert.match((await bash.exec("kill bbbb")).stderr, /nothing running by that id/u, "an ended run isn't running");
	assert.equal((await bash.exec("kill")).exitCode, 1);
});
