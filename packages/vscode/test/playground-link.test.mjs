// TypeScript Playground links → projects (playground-link.ts).
import * as assert from "node:assert/strict";
import { test } from "node:test";

import { decompressFromEncodedURIComponent, parsePlaygroundLink } from "../playground-link.ts";

// A Playground v2 link (its default project): three files under /workspace, greet.ts active.
const V2 = "#code/v2/N4IghgxgLglgbgUwGIwDYJALhAegO4D2ATgNYDOADpAjmURDgOZEIJQB0UZIANCAGZoE3TKHzFyVCDS4QCAO0GN2AKzIKsIYAB15AAj3aQcgLYUhRAPIVYCskcx6d+g4ZBQwRRmwduAogDKAEwADEFBRjy6rm4mBAAmAK7ovkYAcgkIaQgAHlCR0a5GZFBEMNC+pYkIUS4GRvEIEKieYLbylUTVtTFGwgCyCckIAJLyUAhEBBSd3YX1IGQkMBQAMjAARgDCABZNJLMIhQC+PW4w8s2Jjb4A2vNu7LT0OABUr29GhQC6use6vFwhFIlGozwYF0aOU4IhAMDMxCgTj0zFYSOOen4UxMjyYLB8IF0ujk8hKehMwjIYG8egAvCj8VAABRGAAqAE8KAgAhAyjY9AAFFrs5gERLyeJ6OAREAASl0OBwMQAegB+ImXOwEdDsVAERhMilkKneeXyQHiEFSGh0BiotgwzS5CiIzHi6AwBQMtFM+RgCmOEpleSMWVOQosKCJIj6AAGAAkEKg9Tw9AASYB+inHACEsb+ANOiyTTXaWFALrIMHaW21iRM5swQQA7HxK9XPfJ1vIsvWNpMsEE+GQSx6FAEPEQoLXUPXGy3h6P2hPPFBu72TP2iIOi4giFWNE3jkA";

// lz-string's compressToEncodedURIComponent("const x = 1;\n//    ^?\n").
const CLASSIC_SOURCE = "MYewdgzgLgBAHjAvDAjAbgFAHoszzAPQH4Mg";

test("decompresses lz-string's URI encoding, and rejects what isn't", () => {
	assert.equal(decompressFromEncodedURIComponent(CLASSIC_SOURCE), "const x = 1;\n//    ^?\n");
	assert.equal(decompressFromEncodedURIComponent(CLASSIC_SOURCE.replaceAll("+", " ")), "const x = 1;\n//    ^?\n");
	assert.equal(decompressFromEncodedURIComponent(""), undefined);
	assert.equal(decompressFromEncodedURIComponent(CLASSIC_SOURCE.slice(0, 10)), undefined);
});

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

	// { "/etc/passwd": "x", "/workspace/../secret": "y", "/workspace/./a.ts": "z" }: nothing it may write.
	assert.equal(parsePlaygroundLink("#code/v2/N4IgbgpgTgzglgewHYgFwCYA0IBmcA2EMaoA9BAC4DGpADgIYwwDuAJmiAB4janMJQA1jAZUIpAHQTSMCFSiUOATx4g+A4aPHT6EisVQgAXiAC+poA"), undefined);
});
