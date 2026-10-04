// silo's runtime evidence store (lib/util/silo/evidence.ts; RUNTIME-EVIDENCE.md): reached, value and branch
// observations folded run by run — faded weights, strict counts, merged duplicates, other kinds left alone. Run:
//   node --test test/runtime-evidence.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";
import { evidenceText, foldBranches, foldReached, foldSamples, foldValues, HALF_LIFE_RUNS, MAX_SAMPLES, MAX_TAGS, parseEvidence, parseSamples, samplesPath, samplesText } from "@brianjenkins94/util/silo/evidence";

const run = (n) => ({ "id": `run-${n}`, "at": `2026-10-04T00:00:0${n}Z` });
const fade = 2 ** (-1 / HALF_LIFE_RUNS);

test("a value site: strict counts add up run by run, the weight fades", () => {
	let known = foldValues([], [{ "span": "a", "seen": 3, "nullish": 0, "tags": { "function": 3 } }], run(1));

	known = foldValues(known, [{ "span": "a", "seen": 2, "nullish": 1, "tags": { "function": 1, "undefined": 1 } }], run(2));

	const [site] = known;

	assert.deepEqual({ ...site, "w": undefined, "runs": undefined }, { "span": "a", "key": "bablr1", "kind": "value", "w": undefined, "runs": undefined, "ever": 2, "seen": 5, "nullish": 1, "tags": { "function": 4, "undefined": 1 }, "lastRun": "run-2", "lastAt": "2026-10-04T00:00:02Z" });
	assert.ok(Math.abs(site.w - (3 * fade + 2)) < 1e-9 && Math.abs(site.runs - (fade + 1)) < 1e-9);
});

test("a branch: each arm's strict count, a weight of times taken", () => {
	const [branch] = foldBranches(foldBranches([], [{ "span": "b", "arms": [5, 0] }], run(1)), [{ "span": "b", "arms": [1, 2] }], run(2));

	assert.deepEqual(branch.arms, [6, 2]);
	assert.equal(branch.ever, 2);
	assert.ok(Math.abs(branch.w - (5 * fade + 3)) < 1e-9);
});

test("a site a run didn't report only fades; one faded away is dropped", () => {
	let known = foldValues([], [{ "span": "gone", "seen": 1, "nullish": 0, "tags": { "number": 1 } }], run(1));

	known = foldValues(known, [], run(2));
	assert.equal(known[0].seen, 1, "strict counts stay");
	assert.ok(known[0].runs < 1);

	for (let n = 0; n < 200; n += 1) {
		known = foldValues(known, [], run(3));
	}

	assert.deepEqual(known, []);
});

test("each fold leaves the other kinds as they were", () => {
	const known = foldBranches(foldValues(foldReached([], [{ "span": "s", "count": 2 }], run(1)), [{ "span": "v", "seen": 1, "nullish": 1, "tags": { "null": 1 } }], run(1)), [{ "span": "b", "arms": [0, 1] }], run(1));
	const again = foldReached(known, [{ "span": "s", "count": 1 }], run(2));

	assert.deepEqual(again.map((observation) => observation.kind).sort(), ["branch", "reached", "value"]);
	assert.deepEqual(again.find((observation) => observation.kind === "value"), known.find((observation) => observation.kind === "value"));
});

test("two sites a run reports under one span add up; tags past the cap count as other", () => {
	const tags = Object.fromEntries(Array.from({ "length": MAX_TAGS + 2 }, (_, index) => [`T${index}`, index + 1]));
	const [site] = foldValues([], [{ "span": "x", "seen": 1, "nullish": 0, "tags": { "string": 1 } }, { "span": "x", "seen": 55, "nullish": 0, "tags": tags }], run(1));

	assert.equal(site.seen, 56);
	assert.equal(Object.keys(site.tags).length, MAX_TAGS);
	assert.equal(site.tags.other, 1 + 1 + 2 + 3, "the most counted seven kept; the least counted (string, T0, T1, T2) as other");
});

test("an evidence file round-trips every kind, sorted by kind and span", () => {
	const known = foldBranches(foldValues(foldReached([], [{ "span": "s", "count": 1 }], run(1)), [{ "span": "v", "seen": 1, "nullish": 0, "tags": { "number": 1 } }], run(1)), [{ "span": "b", "arms": [1, 0] }], run(1));
	const text = evidenceText(known);

	assert.deepEqual(text.trim().split("\n").map((line) => JSON.parse(line).kind), ["branch", "reached", "value"]);
	assert.deepEqual(parseEvidence(text + "not json\n{\"kind\":\"time\",\"span\":\"t\",\"lastAt\":\"x\"}\n").length, 3, "junk and unknown kinds skipped");
});

test("samples: this machine's, newest distinct first, only for sites the evidence still knows", () => {
	let known = foldSamples([], [{ "span": "a", "values": ["left", "right"] }, { "span": "gone", "values": [1] }], new Set(["a", "gone"]));

	known = foldSamples(known, [{ "span": "a", "values": ["up", "left", 1, 2, 3] }], new Set(["a"]));
	assert.deepEqual(parseSamples(samplesText(known)), [{ "span": "a", "values": ["up", "left", 1, 2, 3].slice(0, MAX_SAMPLES) }]);
	assert.match(samplesPath("src/world.ts"), /^\.silo\/local\/samples\/src\/world\.ts\.jsonl$/u, "under local/: never committed");
});
