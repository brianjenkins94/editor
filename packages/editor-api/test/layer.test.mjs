/**
 * A run's own writable layer (src/runtime.ts `layered`): what a run nobody's watching writes stays in it, what it
 * reads sees its own writes, and the workspace under it is never touched.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { layered } from "../src/runtime.ts";

/** A workspace of `entries` (path → text; a path ending in `/` a folder), as the editor's runtime files answer. */
function workspace(entries) {
	const files = new Map(Object.entries(entries).filter(([path]) => !path.endsWith("/")).map(([path, text]) => [path, new TextEncoder().encode(text)]));
	const folders = new Set(Object.keys(entries).filter((path) => path.endsWith("/")).map((path) => path.slice(0, -1)));
	const touched = [];

	return {
		touched,
		"stat": (path) => (files.has(path) ? { "type": "file", "size": files.get(path).byteLength, "mtime": 0 } : folders.has(path) ? { "type": "directory", "size": 0, "mtime": 0 } : undefined),
		"readFile": (path) => {
			if (!files.has(path)) {
				throw Object.assign(new Error("ENOENT"), { "code": "ENOENT" });
			}

			return files.get(path);
		},
		"readdir": (path) => [...files.keys(), ...folders].filter((each) => each.slice(0, each.lastIndexOf("/")) === path).map((each) => each.slice(path.length + 1)),
		"writeFile": (path) => touched.push(["writeFile", path]),
		"mkdir": (path) => touched.push(["mkdir", path]),
		"rm": (path) => touched.push(["rm", path]),
		"rename": (path) => touched.push(["rename", path])
	};
}

const text = (bytes) => new TextDecoder().decode(bytes);

test("a run's writes stay in its layer, and its reads see them", () => {
	const lower = workspace({ "/workspace/": "", "/workspace/a.txt": "a", "/workspace/data/": "", "/workspace/data/b.txt": "b" });
	const layer = layered(lower);

	layer.writeFile("/workspace/out.txt", "written");
	layer.writeFile("/workspace/a.txt", "changed");
	assert.equal(text(layer.readFile("/workspace/out.txt")), "written", "its own write, read back");
	assert.equal(text(layer.readFile("/workspace/a.txt")), "changed");
	assert.deepEqual(layer.readdir("/workspace"), ["a.txt", "data", "out.txt"], "the workspace's and its own");
	assert.equal(layer.holds("/workspace/out.txt"), true);
	assert.equal(layer.holds("/workspace/data/b.txt"), false, "a file it didn't touch is the workspace's");

	layer.rm("/workspace/data");
	assert.equal(layer.stat("/workspace/data/b.txt"), undefined, "removed with its folder");
	assert.throws(() => layer.readFile("/workspace/data/b.txt"), /ENOENT/u);
	assert.deepEqual(layer.readdir("/workspace"), ["a.txt", "out.txt"]);

	layer.writeFile("/workspace/data/c.txt", "c");
	assert.equal(layer.stat("/workspace/data")?.type, "directory", "a write under a removed folder brings it back");
	assert.deepEqual(layer.readdir("/workspace/data"), ["c.txt"], "with only what the run put there");

	layer.rename("/workspace/a.txt", "/workspace/renamed.txt");
	assert.equal(text(layer.readFile("/workspace/renamed.txt")), "changed");
	assert.equal(layer.stat("/workspace/a.txt"), undefined);

	layer.mkdir("/workspace/new/deep");
	assert.equal(layer.stat("/workspace/new")?.type, "directory");

	assert.deepEqual(lower.touched, [], "the workspace itself never written");
});
