// Type acquisition's specifier scans (workbench/ata.ts): which packages a source file or a declaration file names. Run:
//   node --import tsx --test test/ata.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { exportedTypes, importedPackages, importedSubpaths, references } from "../workbench/ata.ts";

test("imports, requires and dynamic imports name their package roots", () => {
	const source = [
		"import React from \"react\";",
		"import { join } from 'node:path';",
		"export * from \"@scope/pkg/sub\";",
		"const lazy = import(\"lodash/fp\");",
		"const cjs = require( \"chalk\" );",
		"import \"./local\";",
		"import x from\"minified\";"
	].join("\n");

	assert.deepEqual(importedPackages(source).toSorted(), ["@scope/pkg", "@types/node", "chalk", "lodash", "minified", "react"]);
});

test("a `from` inside a string isn't an import: csstype's keys and string unions name no package", () => {
	// csstype's index.d.ts: the closing quote of "-ms-flow-from" and the next key's opening quote once read as `from "…"`,
	// and a union member "from" did the same with the `|` after it — packages named `?: Property.MsFlowFrom | undefined;`
	// and `  | `, fetched from the CDN (and their @types/) on every acquisition.
	const dts = [
		"export interface VendorPropertiesHyphen {",
		"  \"-ms-flow-from\"?: Property.MsFlowFrom | undefined;",
		"  \"-ms-flow-into\"?: Property.MsFlowInto | undefined;",
		"}",
		"type Keyword = \"from\"",
		"  | \"to\";",
		"declare const a: typeof Array.from(\"abc\");",
		"import type { X } from \"real-dep\";"
	].join("\n");

	assert.deepEqual(references(dts).packages, ["real-dep"]);
	assert.deepEqual(importedPackages(dts), ["real-dep"]);
});

test("triple-slash references and the package's own `#` imports still sort into their buckets", () => {
	const dts = "/// <reference types=\"node\" />\n/// <reference path=\"./globals.d.ts\" />\nimport { a } from \"#internal\";\nexport * from \"./rest.js\";\n";

	assert.deepEqual(references(dts), { "relative": ["./globals.d.ts", "./rest.js"], "packages": ["node"], "imports": ["#internal"] });
});

test("a package's subpaths, imported, are each looked up in its exports: a wildcard's too", () => {
	assert.deepEqual(importedSubpaths("import fs from \"unenv/node/fs\";\nimport { x } from \"@scope/kit/deep/one\";\nimport react from \"react\";\nimport \"./local\";"), [["unenv", "node/fs"], ["@scope/kit", "deep/one"]]);

	// (unenv's: `./*` to `./dist/runtime/*.d.mts`)
	const unenv = { ".": { "types": "./dist/index.d.mts", "default": "./dist/index.mjs" }, "./mock/proxy-cjs": { "types": "./lib/mock.d.cts" }, "./*": { "types": "./dist/runtime/*.d.mts", "default": "./dist/runtime/*.mjs" } };

	assert.equal(exportedTypes(unenv, "node/fs"), "./dist/runtime/node/fs.d.mts");
	assert.equal(exportedTypes(unenv, "mock/proxy-cjs"), "./lib/mock.d.cts", "a named subpath before the wildcard");
	assert.equal(exportedTypes({ "./jsx-runtime": "./jsx-runtime.js" }, "jsx-runtime"), "./jsx-runtime.d.ts", "a JS target: its declaration beside it");
	assert.equal(exportedTypes({ "./a": { "types": "./a.d.ts" } }, "b"), undefined);
	assert.equal(exportedTypes(undefined, "anything"), undefined);
});
