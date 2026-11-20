/**
 * What the workspace's file provider keeps of each path's stat (workbench/stat-cache.ts): kept until a change says
 * otherwise — the path's own, a folder above it, or a folder it's in that goes or comes.
 *
 *   node --import tsx --test test/stat-cache.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { statCache } = await import("../workbench/stat-cache.ts");

/** A cache with these paths kept: each a stat, or null for nothing there. */
function kept(entries) {
	const cache = statCache();

	for (const [path, stat] of Object.entries(entries)) {
		cache.remember(path, stat);
	}

	return cache;
}

test("a path's own change forgets it and the folders above it, not its neighbours", () => {
	const cache = kept({
		"/w": "dir",
		"/w/src": "dir",
		"/w/src/a.ts": "a",
		"/w/src/b.ts": "b"
	});

	cache.forget([
		{ "path": "/w/src/a.ts", "type": "changed" }
	]);

	assert.deepEqual([
		"/w",
		"/w/src",
		"/w/src/a.ts",
		"/w/src/b.ts"
	].map((path) => cache.get(path)), [undefined, undefined, undefined, "b"]);
});

test("a file made where nothing was: its missing is forgotten", () => {
	const cache = kept({ "/w/node_modules/x/package.json": null });

	cache.forget([
		{ "path": "/w/node_modules/x/package.json", "type": "added" }
	]);

	assert.equal(cache.get("/w/node_modules/x/package.json"), undefined);
});

test("a folder that goes takes what's kept under it, however deep, and nothing beside it", () => {
	const cache = kept({ "/w/a/b/c/d.ts": "d", "/w/a/e.ts": "e", "/w/f.ts": "f" });

	cache.forget([
		{ "path": "/w/a", "type": "deleted" }
	]);

	assert.deepEqual(["/w/a/b/c/d.ts", "/w/a/e.ts", "/w/f.ts"].map((path) => cache.get(path)), [undefined, undefined, "f"]);
	assert.equal(cache.size(), 1);
});

test("a folder renamed into place: what was asked under it before, missing then, is forgotten", () => {
	const cache = kept({ "/w/new/a.ts": null, "/w/new/sub/b.ts": null });

	cache.forget([
		{ "path": "/w/old", "type": "deleted" },
		{ "path": "/w/new", "type": "added" }
	]);

	assert.equal(cache.size(), 0);
});

test("a file's write forgets only it and above: what's under a folder that merely changed stays", () => {
	const cache = kept({ "/w/src": "dir", "/w/src/a.ts": "a" });

	cache.forget([
		{ "path": "/w/src", "type": "changed" }
	]);

	assert.deepEqual([
		cache.get("/w/src"),
		cache.get("/w/src/a.ts")
	], [undefined, "a"]);
});

test("thousands of files written one at a time, a cache of thousands kept: quick", () => {
	const cache = statCache();

	for (let index = 0; index < 5000; index += 1) {
		cache.remember(`/w/node_modules/pkg${String(index % 50)}/lib/file${String(index)}.d.ts`, null);
	}

	const started = performance.now();

	for (let index = 0; index < 5000; index += 1) {
		cache.forget([
			{ "path": `/w/src/new${String(index)}.ts`, "type": "added" }
		]);
	}

	assert.ok(performance.now() - started < 200, `took ${String(performance.now() - started)} ms`);
	assert.equal(cache.size(), 5000);
});
