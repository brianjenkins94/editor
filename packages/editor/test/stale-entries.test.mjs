// A dev server's prebuild no longer empties dist/, which every dev server in the checkout shares: a page booting on one
// while another starts asked for its extensions' builds as they were deleted, got Vite's HTML fallback, and every
// extension failed with "Unexpected token '<'" (notes.add "not found"). What a build replaces goes once it's ten minutes
// old (build/stale-entries.ts), which outlasts any page's boot.
//
//   node --import tsx --test test/stale-entries.test.mjs
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";

const { pruneStaleEntries, STALE_AFTER_MS } = await import("../build/stale-entries.ts");

const NOW = Date.UTC(2026, 10, 27, 12);

function built(dist, name, browser, files) {
	const folder = path.join(dist, "extensions", name);

	fs.mkdirSync(folder, { "recursive": true });
	fs.writeFileSync(path.join(folder, "package.json"), JSON.stringify({ "name": name, "browser": browser }));

	for (const [file, age] of Object.entries(files)) {
		fs.writeFileSync(path.join(folder, file), "module.exports = {};");
		fs.utimesSync(path.join(folder, file), (NOW - age) / 1000, (NOW - age) / 1000);
	}
}

test("a replaced build goes once it's old; the one the manifest names, a recent one and anything else stay", async () => {
	const dist = fs.mkdtempSync(path.join(os.tmpdir(), "stale-entries-"));

	built(dist, "notes", "extension-0000000a.js", {
		"extension-0000000a.js": STALE_AFTER_MS * 3,
		"extension-0000000b.js": STALE_AFTER_MS * 2,
		"extension-0000000c.js": STALE_AFTER_MS / 2,
		"worker.js": STALE_AFTER_MS * 3
	});

	assert.deepEqual(await pruneStaleEntries(dist, { "now": NOW }), ["notes/extension-0000000b.js"]);
	assert.deepEqual(fs.readdirSync(path.join(dist, "extensions", "notes")).toSorted(), [
		"extension-0000000a.js",
		"extension-0000000c.js",
		"package.json",
		"worker.js"
	]);
	fs.rmSync(dist, { "recursive": true });
});

test("no dist yet, nothing to do", async () => {
	assert.deepEqual(await pruneStaleEntries(path.join(os.tmpdir(), "no-such-dist-" + String(process.pid))), []);
});
