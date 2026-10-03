// TypeScript Playground links → projects (playground-link.ts).
import * as assert from "node:assert/strict";
import { test } from "node:test";

import LZString from "lz-string";

import { parsePlaygroundLink, playgroundLink } from "../playground-link.ts";

// A Playground v2 link (its default project): three files under /workspace, greet.ts active.
const V2 = "#code/v2/N4IghgxgLglgbgUwGIwDYJALhAegO4D2ATgNYDOADpAjmURDgOZEIJQB0UZIANCAGZoE3TKHzFyVCDS4QCAO0GN2AKzIKsIYAB15AAj3aQcgLYUhRAPIVYCskcx6d+g4ZBQwRRmwduAogDKAEwADEFBRjy6rm4mBAAmAK7ovkYAcgkIaQgAHlCR0a5GZFBEMNC+pYkIUS4GRvEIEKieYLbylUTVtTFGwgCyCckIAJLyUAhEBBSd3YX1IGQkMBQAMjAARgDCABZNJLMIhQC+PW4w8s2Jjb4A2vNu7LT0OABUr29GhQC6use6vFwhFIlGozwYF0aOU4IhAMDMxCgTj0zFYSOOen4UxMjyYLB8IF0ujk8hKehMwjIYG8egAvCj8VAABRGAAqAE8KAgAhAyjY9AAFFrs5gERLyeJ6OAREAASl0OBwMQAegB+ImXOwEdDsVAERhMilkKneeXyQHiEFSGh0BiotgwzS5CiIzHi6AwBQMtFM+RgCmOEpleSMWVOQosKCJIj6AAGAAkEKg9Tw9AASYB+inHACEsb+ANOiyTTXaWFALrIMHaW21iRM5swQQA7HxK9XPfJ1vIsvWNpMsEE+GQSx6FAEPEQoLXUPXGy3h6P2hPPFBu72TP2iIOi4giFWNE3jkA";

// lz-string's compressToEncodedURIComponent("const x = 1;\n//    ^?\n").
const CLASSIC_SOURCE = "MYewdgzgLgBAHjAvDAjAbgFAHoszzAPQH4Mg";

test("a v2 link opens its whole project, on its active file", () => {
	const project = parsePlaygroundLink(V2);

	assert.deepEqual(project.files.map((file) => file.path).sort(), ["/workspace/src/greet.ts", "/workspace/src/index.ts", "/workspace/tsconfig.json"]);
	assert.deepEqual(project.openEditors, ["/workspace/src/greet.ts"]);
	assert.match(project.files.find((file) => file.path === "/workspace/src/index.ts").contents, /\/\/ {4}\^\?/u);
	assert.equal(JSON.parse(project.files.find((file) => file.path === "/workspace/tsconfig.json").contents).compilerOptions.module, "NodeNext");
});

test("a classic link is one file, with the playground's defaults under the query's options", () => {
	const project = parsePlaygroundLink("#code/" + CLASSIC_SOURCE, "?target=99&strict=false&ts=5.4.5&ssl=2");
	const tsconfig = JSON.parse(project.files.find((file) => file.path === "/workspace/tsconfig.json").contents);

	assert.deepEqual(project.openEditors, ["/workspace/input.tsx"]);
	assert.equal(project.files.find((file) => file.path === "/workspace/input.tsx").contents, "const x = 1;\n//    ^?\n");
	assert.equal(tsconfig.compilerOptions.target, "ESNext");
	assert.equal(tsconfig.compilerOptions.strict, false);
	assert.equal(tsconfig.compilerOptions.jsx, "react");
	assert.equal(tsconfig.compilerOptions.ts, undefined);
	assert.equal(tsconfig.compilerOptions.ssl, undefined);
});

test("a classic link's file is named as the playground names it", () => {
	assert.deepEqual(parsePlaygroundLink("#code/" + CLASSIC_SOURCE, "?jsx=0").openEditors, ["/workspace/input.ts"]);
	assert.deepEqual(parsePlaygroundLink("#code/" + CLASSIC_SOURCE, "?useJavaScript=true").openEditors, ["/workspace/input.jsx"]);
	assert.deepEqual(parsePlaygroundLink("#code/" + CLASSIC_SOURCE, "?filetype=d.ts").openEditors, ["/workspace/input.d.ts"]);
	assert.equal(JSON.parse(parsePlaygroundLink("#code/" + CLASSIC_SOURCE, "?jsx=0").files[0].contents).compilerOptions.jsx, undefined);
});

test("#src= is plain URI-encoded source", () => {
	const project = parsePlaygroundLink("#src=" + encodeURIComponent("let y: number = 2"));

	assert.equal(project.files.find((file) => file.path === "/workspace/input.tsx").contents, "let y: number = 2");
	assert.equal(parsePlaygroundLink("#src=%E0%A4%A"), undefined);
});

test("only playground hashes are links, and a v2 project stays inside /workspace", () => {
	assert.equal(parsePlaygroundLink(""), undefined);
	assert.equal(parsePlaygroundLink("#example/hello-world"), undefined);
	assert.equal(parsePlaygroundLink("#code/v2/not-lz"), undefined);
	assert.equal(parsePlaygroundLink("#code/"), undefined);

	// { "/etc/passwd": "x", "/workspace/../secret": "y", "/workspace/./a.ts": "z" }: nothing it may write.
	assert.equal(parsePlaygroundLink("#code/v2/N4IgbgpgTgzglgewHYgFwCYA0IBmcA2EMaoA9BAC4DGpADgIYwwDuAJmiAB4janMJQA1jAZUIpAHQTSMCFSiUOATx4g+A4aPHT6EisVQgAXiAC+poA"), undefined);
});

test("a share link round-trips the workspace, without its binary files", () => {
	const encode = (text) => new TextEncoder().encode(text);
	const selection = { "positionLineNumber": 2, "positionColumn": 5, "selectionStartLineNumber": 2, "selectionStartColumn": 1 };
	const { skipped, url } = playgroundLink("https://example.test/editor/", {
		"files": [
			{ "path": "/workspace/tsconfig.json", "bytes": encode("{}") },
			{ "path": "/workspace/src/index.ts", "bytes": encode("export const x = 1\n") },
			{ "path": "/workspace/sprite.png", "bytes": new Uint8Array([137, 80, 78, 71, 0, 1]) },
			{ "path": "/workspace/latin1.txt", "bytes": new Uint8Array([0xE9, 0x41]) }
		],
		"activeFile": "/workspace/src/index.ts",
		"selection": selection
	});

	assert.ok(url.startsWith("https://example.test/editor/#code/v2/"));
	assert.deepEqual(skipped, ["/workspace/sprite.png", "/workspace/latin1.txt"]);

	const project = parsePlaygroundLink(url.slice(url.indexOf("#")));

	assert.deepEqual(project.openEditors, ["/workspace/src/index.ts"]);
	assert.deepEqual(project.files, [{ "path": "/workspace/tsconfig.json", "contents": "{}" }, { "path": "/workspace/src/index.ts", "contents": "export const x = 1\n" }]);
	assert.deepEqual(JSON.parse(LZString.decompressFromEncodedURIComponent(url.slice(url.indexOf("#code/v2/") + 9))).selection, selection);
});

test("a share link names no active file it doesn't carry", () => {
	const { url } = playgroundLink("https://example.test/", { "files": [{ "path": "/workspace/a.ts", "bytes": new TextEncoder().encode("1") }], "activeFile": "/workspace/sprite.png" });
	const state = JSON.parse(LZString.decompressFromEncodedURIComponent(url.slice(url.indexOf("#code/v2/") + 9)));

	assert.equal(state.activeFile, undefined);
	assert.equal(state.selection, undefined);
});
