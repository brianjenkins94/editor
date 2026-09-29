// The workspace's change stream (workspace-changes.ts), against a real zen-fs SingleBuffer store mounted at
// /workspace — the same backend every realm shares. Each case runs some `fs` calls and asserts the batch reported.
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { configure, fs, mounts, SingleBuffer } from "@zenfs/core";

import { watchWorkspaceStore } from "../workspace-changes.ts";

await configure({ "mounts": { "/workspace": { "backend": SingleBuffer, "buffer": new SharedArrayBuffer(8 * 1024 * 1024) } } });

const batches = [];

watchWorkspaceStore(mounts.get("/workspace"), "/workspace", (changes) => { batches.push(changes); }, 1);

/** Run `act`, let the batch flush, and return the changes it reported (sorted by path). */
async function changesOf(act) {
	batches.length = 0;
	act();
	await new Promise((resolve) => { setTimeout(resolve, 20); });

	return batches.flat().sort((a, b) => a.path.localeCompare(b.path));
}

test("creating a file is one add (its writes fold into it), with an absolute path", async () => {
	assert.deepEqual(await changesOf(() => { fs.writeFileSync("/workspace/a.txt", "hello"); }), [{ "path": "/workspace/a.txt", "type": "added" }]);
});

test("rewriting a file is a change", async () => {
	assert.deepEqual(await changesOf(() => { fs.writeFileSync("/workspace/a.txt", "hello again"); }), [{ "path": "/workspace/a.txt", "type": "changed" }]);
});

test("emptying a file (only a touch in zen-fs) is a change", async () => {
	assert.deepEqual(await changesOf(() => { fs.writeFileSync("/workspace/a.txt", ""); }), [{ "path": "/workspace/a.txt", "type": "changed" }]);
	fs.writeFileSync("/workspace/a.txt", "back");
	assert.deepEqual(await changesOf(() => { fs.truncateSync("/workspace/a.txt", 0); }), [{ "path": "/workspace/a.txt", "type": "changed" }]);
});

test("reading is not a change", async () => {
	fs.writeFileSync("/workspace/a.txt", "read me");
	await changesOf(() => undefined);
	assert.deepEqual(await changesOf(() => { fs.readFileSync("/workspace/a.txt", "utf8"); fs.statSync("/workspace/a.txt"); fs.readdirSync("/workspace"); }), []);
});

test("a recursive delete reports every file and directory under it", async () => {
	fs.mkdirSync("/workspace/dir/sub", { "recursive": true });
	fs.writeFileSync("/workspace/dir/one.txt", "1");
	fs.writeFileSync("/workspace/dir/sub/two.txt", "2");
	await changesOf(() => undefined);

	const changes = await changesOf(() => { fs.rmSync("/workspace/dir", { "recursive": true }); });

	assert.ok(changes.every((change) => change.type === "deleted"), JSON.stringify(changes));
	assert.deepEqual(changes.map((change) => change.path), ["/workspace/dir", "/workspace/dir/one.txt", "/workspace/dir/sub", "/workspace/dir/sub/two.txt"]);
});

test("renaming a directory deletes the old path and adds the new one", async () => {
	fs.mkdirSync("/workspace/old");
	fs.writeFileSync("/workspace/old/file.txt", "x");
	await changesOf(() => undefined);
	assert.deepEqual(await changesOf(() => { fs.renameSync("/workspace/old", "/workspace/new"); }), [
		{ "path": "/workspace/new", "type": "added" },
		{ "path": "/workspace/old", "type": "deleted" }
	]);
	assert.equal(fs.readFileSync("/workspace/new/file.txt", "utf8"), "x");
});
