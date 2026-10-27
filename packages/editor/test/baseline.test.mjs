// The editor's dependency baseline (extensions/capabilities/baseline.ts): a package's own code read out of its published tarball, and
// the packages a lockfile installs. Run:
//   node --import tsx --test test/baseline.test.mjs
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { packageCaps } from "@brianjenkins94/util/silo/detect";
import { unpack } from "@brianjenkins94/almostnode/packages";
import { choose, installsLocally, linkedFolder, lockedVersions, resolveVersions } from "../workbench/versions.ts";

test("a tarball's files, long paths included — bytes as they are, and what packageCaps makes of them", async () => {
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
	// (each way a long path is written: pax, as npm's tarballs have it, and GNU tar's — `gnu` to GNU tar, `gnutar` to bsdtar)
	const tar = (format) => execFileSync("tar", ["czf", "probe.tgz", "--format", format, "package"], { "cwd": dir, "env": { ...process.env, "COPYFILE_DISABLE": "1" }, "stdio": "ignore" });

	for (const format of ["pax", "gnu"]) {
		try {
			tar(format);
		} catch {
			tar(format === "gnu" ? "gnutar" : format);
		}

		const files = unpack(new Uint8Array(fs.readFileSync(path.join(dir, "probe.tgz"))));

		assert.deepEqual([...files.keys()].toSorted(), ["README.md", "index.js", deep, "package.json", "probe.wasm"].toSorted(), `every file, by its path in the package (${format})`);
		assert.deepEqual(files.get("probe.wasm"), binary);
		// (as the package worker reads it: the README naming fetch isn't code)
		assert.deepEqual(packageCaps([...files].map(([file, bytes]) => [file, new TextDecoder().decode(bytes)])), ["exec", "net"]);
	}
});

test("a lockfile's packages: each name once, root before nested, a link by its folder — and what each depends on", () => {
	assert.deepEqual(lockedVersions({ "packages": {
		"": { "version": "0.0.0" },
		"node_modules/a/node_modules/b": { "version": "1.0.0" },
		"node_modules/b": { "version": "2.0.0", "resolved": "https://registry.npmjs.org/b/-/b-2.0.0.tgz", "dependencies": { "@s/c": "^3" }, "peerDependencies": { "react": "*" } },
		"node_modules/@s/c": { "version": "3.0.0" },
		"node_modules/local": { "version": "0.0.1", "link": true },
		"node_modules/theme": { "resolved": "../theme", "link": true },
		"packages/app": { "version": "1.0.0" }
	} }, "packages/editor"), {
		"b": { "version": "2.0.0", "range": "2.0.0", "tarball": "https://registry.npmjs.org/b/-/b-2.0.0.tgz", "dependencies": ["@s/c", "react"] },
		"@s/c": { "version": "3.0.0", "range": "3.0.0", "dependencies": [] },
		"theme": { "version": "0.0.0", "range": "file:../theme", "link": "packages/theme" }
	}, "a link with no folder is left out");
});

test("a link's folder, relative to the workspace root; what the editor installs itself", () => {
	assert.equal(linkedFolder("packages/editor", "file:../theme"), "packages/theme");
	assert.equal(linkedFolder("", "file:./vendor/x/"), "vendor/x");
	assert.equal(linkedFolder("a/b", "link:../../c"), "c");
	assert.equal(installsLocally({ "version": "1.0.0", "range": "file:../theme", "link": "packages/theme" }), true);
	assert.equal(installsLocally({ "version": "0.1.0", "range": "0.1.0", "tarball": "https://brianjenkins94.github.io/lib/util@latest.tgz" }), true, "a tarball elsewhere: no CDN has it");
	assert.equal(installsLocally({ "version": "2.0.0", "range": "2.0.0", "tarball": "https://registry.npmjs.org/b/-/b-2.0.0.tgz" }), false, "the registry's: the CDN serves it");
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
	const known = { "react": { "version": "18.2.0", "range": "^18.2.0", "dependencies": ["loose-envify"] }, "loose-envify": { "version": "1.4.0", "range": "^1.1.0", "dependencies": [] } };
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

test("one resolved before its dependencies were kept: they're read, its version as it was", async () => {
	const realFetch = globalThis.fetch;
	const manifests = { "https://registry.npmjs.org/react/18.2.0": { "dependencies": { "loose-envify": "^1.1.0" } }, "https://registry.npmjs.org/loose-envify/1.4.0": { "dependencies": {} } };

	globalThis.fetch = async (url) => (manifests[String(url)] === undefined ? Response.error() : Response.json(manifests[String(url)]));

	try {
		const known = { "react": { "version": "18.2.0", "range": "^18.2.0" }, "loose-envify": { "version": "1.4.0", "range": "^1.1.0" } };

		assert.deepEqual(await resolveVersions({ "react": "^18.2.0" }, { known }), {
			"loose-envify": { "version": "1.4.0", "range": "^1.1.0", "dependencies": [] },
			"react": { "version": "18.2.0", "range": "^18.2.0", "dependencies": ["loose-envify"] }
		});
	} finally {
		globalThis.fetch = realFetch;
	}
});

test("a platform build — a native binary for some OS or CPU — is marked, its version resolved as any other's", async () => {
	const realFetch = globalThis.fetch;
	const binary = "@typescript/typescript-linux-x64";
	const old = "2026-07-01T00:00:00Z";
	const answers = {
		"https://api.deps.dev/v3/systems/npm/packages/typescript": { "versions": [{ "versionKey": { "version": "7.0.2" }, "publishedAt": old, "isDefault": true }] },
		[`https://api.deps.dev/v3/systems/npm/packages/${encodeURIComponent(binary)}`]: { "versions": [{ "versionKey": { "version": "7.0.2" }, "publishedAt": old, "isDefault": true }] },
		"https://registry.npmjs.org/typescript/7.0.2": { "optionalDependencies": { [binary]: "7.0.2" } },
		[`https://registry.npmjs.org/${binary}/7.0.2`]: { "os": ["linux"], "cpu": ["x64"] }
	};

	globalThis.fetch = async (url) => (answers[String(url)] === undefined ? Response.error() : Response.json(answers[String(url)]));

	try {
		assert.deepEqual(await resolveVersions({ "typescript": "^7.0.0" }, { "now": Date.parse("2026-10-14T00:00:00Z") }), {
			[binary]: { "version": "7.0.2", "range": "7.0.2", "dependencies": [], "platform": true },
			"typescript": { "version": "7.0.2", "range": "^7.0.0", "dependencies": [binary] }
		});
	} finally {
		globalThis.fetch = realFetch;
	}

	// A lockfile says so too: its entry's os/cpu.
	assert.deepEqual(lockedVersions({ "packages": { "": {}, [`node_modules/${binary}`]: { "version": "7.0.2", "os": ["linux"], "cpu": ["x64"], "optional": true } } })[binary], { "version": "7.0.2", "range": "7.0.2", "dependencies": [], "platform": true });
});
