// What the debug worker sums of a tsval run's observed sites (extensions/worker-pod/site-sums.ts): values, branches,
// type tags and a few primitives per site, and a fork that goes on from a copy. Run:
//   node --import tsx --test test/site-sums.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { createVM } from "@brianjenkins94/tsval";
import { addObservation, copySums, siteObservations } from "../extensions/worker-pod/site-sums.ts";

/** Run `code` under tsval, summing its observed sites, and return the sums and the source file. */
function run(code) {
	const sums = new Map();
	const { vm, sourceFile } = createVM(code, { "observe": (node, site, value) => { addObservation(sums, node, site, value); } });

	vm.run();

	return { sums, sourceFile };
}

test("a value site: how often seen, how often nullish, each type tag, a few distinct primitives", () => {
	const { sums, sourceFile } = run([
		"const pick = (key?: string) => key ?? 'none';",
		"for (const key of ['a', 'b', 'a', undefined]) { pick(key); }"
	].join("\n"));
	const sites = siteObservations(sums, sourceFile);
	const [returned, parameter, nullish] = ["return", "parameter", "nullish"].map((kind) => sites.find((site) => site.site === kind));

	assert.deepEqual(parameter, { "site": "parameter", "start": [0, 14], "end": [0, 26], "seen": 4, "nullish": 1, "tags": { "string": 3, "undefined": 1 }, "samples": ["a", "b"] });
	assert.deepEqual(nullish, { "site": "nullish", "start": [0, 31], "end": [0, 44], "seen": 4, "nullish": 1, "tags": { "string": 3, "undefined": 1 }, "samples": ["a", "b"] });
	assert.deepEqual(returned, { "site": "return", "start": [0, 13], "end": [0, 44], "seen": 4, "nullish": 0, "tags": { "string": 4 }, "samples": ["a", "b", "none"] });
	assert.equal(sites[0], returned, "in source order: the arrow starts first");
});

test("a branch site: how often each arm ran, both arms there even when one never did", () => {
	const { sums, sourceFile } = run("let n = 0;\nfor (let i = 0; i < 3; i++) { if (n > 10) { n = 0; } n += 1; }");
	const branch = siteObservations(sums, sourceFile).find((site) => site.site === "branch");

	assert.deepEqual(branch.arms, [0, 3]);
	assert.equal(branch.seen, undefined, "a branch counts arms, not values");
});

test("tags past eight count as other; samples stop at five, strings cut short", () => {
	const sums = new Map();
	const file = { "getLineAndCharacterOfPosition": () => ({ "line": 0, "character": 0 }) };
	const node = { "getStart": () => 0, "getEnd": () => 1, "getSourceFile": () => file };
	const values = [1, "x".repeat(100), true, null, undefined, [], {}, new Map(), new Set(), () => 1, 2, 3, 4, 5];

	for (const value of values) {
		addObservation(sums, node, "parameter", value);
	}

	const [site] = siteObservations(sums, file);

	assert.equal(Object.keys(site.tags).length, 9);
	assert.equal(site.tags.other, 2, "kinds past eight (a Set, a function) count as other");
	assert.deepEqual(site.samples, [1, "x".repeat(40), true, 2, 3]);
});

test("a fork's sums go on from a copy, leaving its stop's as they were", () => {
	const sums = new Map();
	const node = { "getStart": () => 0, "getEnd": () => 1 };

	addObservation(sums, node, "branch", 0);

	const fork = copySums(sums);

	addObservation(fork, node, "branch", 1);
	assert.deepEqual([sums.get(node).arms, fork.get(node).arms], [[1, 0], [1, 1]]);
});

test("a file's report has only its own sites — the program's other files report theirs", () => {
	const sums = new Map();
	const position = () => ({ "line": 0, "character": 0 });
	const [main, other] = [{ "getLineAndCharacterOfPosition": position }, { "getLineAndCharacterOfPosition": position }];

	addObservation(sums, { "getStart": () => 0, "getEnd": () => 1, "getSourceFile": () => main }, "parameter", 1);
	addObservation(sums, { "getStart": () => 0, "getEnd": () => 1, "getSourceFile": () => other }, "parameter", "x");

	assert.deepEqual(siteObservations(sums, main).map((site) => site.samples), [[1]]);
	assert.deepEqual(siteObservations(sums, other).map((site) => site.samples), [["x"]]);
});
