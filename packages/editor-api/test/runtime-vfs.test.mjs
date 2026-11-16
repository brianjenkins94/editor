/**
 * The workspace runtime's files as almostnode's VirtualFS (src/runtime-vfs.ts): a folder's entries with their kinds in
 * one call, where the files list them — the call almostnode's fs makes for `withFileTypes`, rather than a stat an entry.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { RuntimeVfs } from "../src/runtime-vfs.ts";

/** The editor's runtime files for a folder of `a.txt` and `sub/`, each call kept; with `entries` when `typed`. */
function files(typed) {
	const asked = [];
	const listing = [
		{ "name": "a.txt", "type": "file" },
		{ "name": "sub", "type": "directory" }
	];

	return {
		"asked": asked,
		"stat": (path) => {
			asked.push(["stat", path]);

			return path === "/workspace/w/sub"
				? { "type": "directory", "size": 0, "mtime": 0 }
				: { "type": "file", "size": 1, "mtime": 0 };
		},
		"readdir": (path) => {
			asked.push(["readdir", path]);

			return listing.map(({ name }) => name);
		},
		...typed
			? {
					"entries": (path) => {
						asked.push(["entries", path]);

						return listing;
					}
				}
			: {}
	};
}

test("a workspace folder's entries come with their kinds in one call, where the files list them", () => {
	const typed = files(true);
	const vfs = new RuntimeVfs(typed);

	assert.deepEqual(vfs.direntsSync("/workspace/w"), [
		{ "name": "a.txt", "type": "file" },
		{ "name": "sub", "type": "directory" }
	]);
	assert.deepEqual(typed.asked, [
		["entries", "/workspace/w"]
	]);
});

test("where they don't (a run's layer), or outside the workspace, there's no typed listing: the entries are statted", () => {
	const plain = files(false);

	assert.equal(new RuntimeVfs(plain).direntsSync("/workspace/w"), undefined);
	assert.equal(new RuntimeVfs(files(true)).direntsSync("/tmp"), undefined, "a run's own temp files are its memory's");
	assert.deepEqual(plain.asked, []);
});
