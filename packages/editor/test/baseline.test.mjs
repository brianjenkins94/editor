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
import { lockedPackages, tarballTexts } from "../workbench/baseline.ts";

test("a tarball's code files, long paths included — and what detect makes of them", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "baseline-"));
	const deep = "lib/" + "very-long-folder-name-".repeat(5) + "/index.js";

	fs.mkdirSync(path.join(dir, "package", path.dirname(deep)), { "recursive": true });
	fs.writeFileSync(path.join(dir, "package", "package.json"), "{\"name\":\"probe\",\"version\":\"1.0.0\"}");
	fs.writeFileSync(path.join(dir, "package", "index.js"), "module.exports = () => require('child_process').execSync('ls');\n");
	fs.writeFileSync(path.join(dir, "package", deep), "module.exports = () => fetch('https://example.com');\n");
	fs.writeFileSync(path.join(dir, "package", "README.md"), "fetch('https://not.code');\n");
	// (COPYFILE_DISABLE: macOS's tar would add its ._ metadata files, which no published tarball has)
	execFileSync("tar", ["czf", "probe.tgz", "package"], { "cwd": dir, "env": { ...process.env, "COPYFILE_DISABLE": "1" } });

	const texts = await tarballTexts(Readable.toWeb(fs.createReadStream(path.join(dir, "probe.tgz"))));

	assert.deepEqual([...texts.keys()].toSorted(), ["package/index.js", "package/" + deep], "the code files, by their whole path");
	assert.deepEqual([...new Set([...texts.values()].flatMap((text) => detect(text)))].toSorted(), ["exec", "net"]);
});

test("a lockfile's packages: each name once, root before nested, links left out", () => {
	assert.deepEqual(lockedPackages({ "packages": {
		"": { "version": "0.0.0" },
		"node_modules/a/node_modules/b": { "version": "1.0.0" },
		"node_modules/b": { "version": "2.0.0", "resolved": "https://registry.npmjs.org/b/-/b-2.0.0.tgz" },
		"node_modules/@s/c": { "version": "3.0.0" },
		"node_modules/local": { "version": "0.0.1", "link": true },
		"packages/app": { "version": "1.0.0" }
	} }), [
		{ "name": "b", "version": "2.0.0", "tarball": "https://registry.npmjs.org/b/-/b-2.0.0.tgz" },
		{ "name": "@s/c", "version": "3.0.0" }
	]);
});
