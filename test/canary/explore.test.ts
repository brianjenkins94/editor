/**
 * Fork-based multi-path exploration: the canary's answer to "one run, one path" (ASSIGNMENT §3).
 */
import { test } from "node:test";
import assert from "node:assert";
import { exploreCanary, runCanary } from "../../src/canary.ts";

test("finds a capability behind a branch a single run never takes", () => {
	const code = `const mode = "safe"; let out = 0; if (mode === "danger") { fetch("https://evil.com"); } else { out = 1; } out;`;

	const single = runCanary(code, { predicted: [] });
	assert.ok(single.ok, "a plain run never reaches the fetch");
	assert.strictEqual(single.completion, 1);

	const explored = exploreCanary(code, { predicted: [] });
	assert.strictEqual(explored.ok, false, "exploration forces the other branch and finds it");
	assert.strictEqual(explored.paths.length, 2);

	const [root, forced] = explored.paths;
	assert.ok(!root.aborted && root.completion === 1);
	assert.strictEqual(forced.parent, 0);
	assert.deepStrictEqual(forced.decisions.map((d) => d.forced), [true]);
	assert.strictEqual(forced.divergence?.capability, "net");
	assert.strictEqual(forced.divergence?.value, "https://evil.com");
	assert.strictEqual(forced.divergence?.path, 1, "reaches are stamped with their path");
});

test("Axis-2 across paths: both arms of a ?: yield their resource", () => {
	const explored = exploreCanary(`const url = 1 < 2 ? "https://a.example" : "https://b.example"; fetch(url);`, { predicted: ["net"] });
	assert.ok(explored.ok);
	assert.deepStrictEqual(
		explored.observed.map((e) => [e.path, e.value]),
		[
			[0, "https://a.example"],
			[1, "https://b.example"],
		],
	);
});

test("the path budget bounds exploration and reports truncation", () => {
	const explored = exploreCanary(`let n = 0; for (let i = 0; i < 10; i++) { if (i % 2 === 0) { n++; } } n;`, { predicted: [], maxPaths: 4 });
	assert.ok(explored.ok);
	assert.strictEqual(explored.paths.length, 4);
	assert.strictEqual(explored.truncated, true);
});

test("a forced branch that throws is contained to its path", () => {
	const explored = exploreCanary(`const x = null; let r = "ok"; if (x === null) { r = "null"; } else { r = x.y; } r;`, { predicted: [] });
	assert.ok(explored.ok, "no divergence anywhere");
	const [root, forced] = explored.paths;
	assert.strictEqual(root.completion, "null");
	assert.ok(forced.error instanceof TypeError, "the forced path dereferenced null and only that path failed");
});

test("nested branch points fork recursively, each path carrying its full decision trail", () => {
	const code = `let s = ""; if (1 > 2) { s += "A"; if (2 > 3) { s += "B"; } } else { s += "C"; } s;`;
	const explored = exploreCanary(code, { predicted: [] });
	// root: outer false → "C"; fork 1: outer forced true, inner observed false → "A";
	// fork 2 (from fork 1): inner forced true → "AB".
	assert.deepStrictEqual(
		explored.paths.map((p) => [p.completion, p.decisions.map((d) => d.forced)]),
		[
			["C", [false]],
			["A", [true, false]],
			["AB", [true, true]],
		],
	);
});
