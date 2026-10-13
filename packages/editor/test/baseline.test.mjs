// The editor's dependency baseline (workbench/baseline.ts): a package's own code read out of its published tarball, and
// the packages a lockfile installs. Run:
//   node --import tsx --test test/baseline.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { detect } from "@brianjenkins94/util/silo/detect";
import { tarballFiles } from "../workbench/install.ts";
import { choose, lockedVersions, resolveVersions } from "../workbench/versions.ts";

test("a tarball's files, long paths included — bytes as they are, and what detect makes of its code", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-"));
	const deep = "lib/" + "very-long-folder-name-".repeat(5) + "/index.js";
	const binary = Uint8Array.of(0, 97, 115, 109, 255, 1);

	fs.mkdirSync(path.join(dir, "package", path.dirname(deep)), { "recursive": true });
	fs.writeFileSync(path.join(dir, "package", "package.json"), "{\"name\":\"probe\",\"version\":\"1.0.0\"}");
	fs.writeFileSync(path.join(dir, "package", "index.js"), "module.exports = () => require('child_process').execSync('ls');\n");
	fs.writeFileSync(path.join(dir, "package", deep), "module.exports = () => fetch('https://example.com');\n");
	fs.writeFileSync(path.join(dir, "package", "README.md"), "fetch('https://not.code');\n");
	fs.writeFileSync(path.join(dir, "package", "probe.wasm"), binary);
	// (COPYFILE_DISABLE: macOS's tar would add its ._ metadata files, which no published tarball has)
	execFileSync("tar", ["czf", "probe.tgz", "package"], { "cwd": dir, "env": { ...process.env, "COPYFILE_DISABLE": "1" } });

	const files = await tarballFiles(Readable.toWeb(fs.createReadStream(path.join(dir, "probe.tgz"))));
	const code = [...files].filter(([file]) => file.endsWith(".js"));

	assert.deepEqual([...files.keys()].toSorted(), ["README.md", "index.js", deep, "package.json", "probe.wasm"].toSorted(), "every file, by its path in the package");
	assert.deepEqual(files.get("probe.wasm"), binary);
	assert.deepEqual([...new Set(code.flatMap(([, bytes]) => detect(new TextDecoder().decode(bytes))))].toSorted(), ["exec", "net"]);
});

test("a lockfile's packages: each name once, root before nested, links left out", () => {
	assert.deepEqual(lockedVersions({ "packages": {
		"": { "version": "0.0.0" },
		"node_modules/a/node_modules/b": { "version": "1.0.0" },
		"node_modules/b": { "version": "2.0.0", "resolved": "https://registry.npmjs.org/b/-/b-2.0.0.tgz" },
		"node_modules/@s/c": { "version": "3.0.0" },
		"node_modules/local": { "version": "0.0.1", "link": true },
		"packages/app": { "version": "1.0.0" }
	} }), {
		"b": { "version": "2.0.0", "range": "2.0.0", "tarball": "https://registry.npmjs.org/b/-/b-2.0.0.tgz" },
		"@s/c": { "version": "3.0.0", "range": "3.0.0" }
	});
});

test("a range resolved with nothing younger than a week — `latest` the latest a week old", () => {
	const now = Date.parse("2026-10-13T00:00:00Z");
	const cutoff = now - 7 * 24 * 60 * 60 * 1000;
	const versions = [
		{ "version": "18.2.0", "at": "2026-01-01T00:00:00Z" },
		{ "version": "18.3.1", "at": "2026-09-01T00:00:00Z" },
		{ "version": "18.3.2", "at": "2026-10-12T00:00:00Z", "latest": true },
		{ "version": "19.0.0-rc.1", "at": "2026-09-02T00:00:00Z" }
	];

	assert.deepEqual(choose(versions, "latest", cutoff), { "version": "18.3.1", "young": false }, "the newest stable one a week old, not yesterday's");
	assert.deepEqual(choose(versions, "^18.2.0", cutoff), { "version": "18.3.1", "young": false });
	assert.deepEqual(choose(versions, "18.2.0", cutoff), { "version": "18.2.0", "young": false });
	assert.deepEqual(choose(versions, ">=18.3.2", cutoff), { "version": "18.3.2", "young": true }, "nothing old enough: the newest that satisfies, young");
	assert.equal(choose(versions, "next", cutoff), undefined, "another dist-tag: not read here");
});

test("what's resolved already stays — a lockfile's way: nothing asked again", async () => {
	const known = { "react": { "version": "18.2.0", "range": "^18.2.0" }, "loose-envify": { "version": "1.4.0", "range": "^1.1.0" } };
	const asked = [];
	const realFetch = globalThis.fetch;

	globalThis.fetch = async (url) => {
		asked.push(String(url));

		throw new Error("offline");
	};

	try {
		assert.deepEqual(await resolveVersions({ "react": "^18.2.0" }, { known }), known);
		assert.deepEqual(asked, []);
	} finally {
		globalThis.fetch = realFetch;
	}
});
