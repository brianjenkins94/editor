// What ESLint's worker has read ahead before it loads its configs (workbench/node-modules-provider.ts's prefetchFor, its scan in node-modules-prefetch.ts): the
// packages a config names, however it reaches them, and the files of its own it imports by a relative path.
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { packagesNamedBy, relativeImports } from "../workbench/node-modules-prefetch.ts";

const PINNED = { "@awesome.me/webawesome": "3.0.0", "@brianjenkins94/util": "1.0.0", "globals": "16.0.0" };

test("a config names a pinned package by an import, a require, or a path resolved in it", () => {
	const text = `import config from "@brianjenkins94/util/eslint";
import * as path from "node:path";
const dir = createRequire(import.meta.url).resolve("@awesome.me/webawesome/dist/components/button/button.js");
const g = require('globals');
const other = "not-pinned/x";`;

	assert.deepEqual(packagesNamedBy(text, PINNED).toSorted(), ["@awesome.me/webawesome", "@brianjenkins94/util", "globals"]);
});

test("its own files, imported by a relative path, statically or not", () => {
	const text = `import webawesome from "./packages/eslint-plugin-webawesome/src/index.js";
import "../side-effect.mjs";
const later = await import("./later.js");
const cjs = require("../cjs");
const notAnImport = "./just-a-string.js";`;

	assert.deepEqual(relativeImports(text), [
		"./packages/eslint-plugin-webawesome/src/index.js",
		"../side-effect.mjs",
		"./later.js",
		"../cjs"
	]);
});
