// What each keep of an editor's own evidence sends (shell/own-evidence.ts `deltaOf`): only what happened since the last,
// so a stretch the editor sat idle isn't a run in which its code didn't run, and nothing is counted twice.
//
//   node --import tsx --test test/own-evidence.test.mjs
import assert from "node:assert/strict";
import { test } from "node:test";

const { deltaOf } = await import("../shell/own-evidence.ts");

const statement = (line, count) => ({ "start": [line, 0], "end": [line, 9], "count": count });
const value = (seen, nullish, tags) => ({ "site": "parameter", "start": [0, 10], "end": [0, 14], "seen": seen, "nullish": nullish, "tags": tags, "samples": ["a"] });
const branch = (arms) => ({ "site": "branch", "start": [1, 1], "end": [3, 2], "arms": arms });
const module = (statements, sites) => ({ "file": "packages/editor/shell/x.ts", "version": "v", "statements": statements, "sites": sites });

test("the first keep sends what ran; a statement that didn't, nothing", () => {
	const kept = deltaOf(undefined, module([statement(1, 2), statement(2, 0)], [value(2, 0, { "string": 2 })]));

	assert.deepEqual(kept.statements, [statement(1, 2)]);
	assert.deepEqual(kept.sites, [value(2, 0, { "string": 2 })]);
});

test("a later keep sends what ran since: counts, values and arms less what was sent", () => {
	const before = module([statement(1, 2), statement(2, 0)], [value(2, 0, { "string": 2 }), branch([1, 0])]);
	const now = module([statement(1, 5), statement(2, 1)], [value(4, 1, { "string": 3, "null": 1 }), branch([1, 2])]);
	const kept = deltaOf(before, now);

	assert.deepEqual(kept.statements, [statement(1, 3), statement(2, 1)]);
	assert.deepEqual(kept.sites, [value(2, 1, { "string": 1, "null": 1 }), branch([0, 2])]);
});

test("nothing since: nothing to keep, not a run in which nothing ran", () => {
	const both = module([statement(1, 2)], [value(2, 0, { "string": 2 }), branch([1, 1])]);

	assert.equal(deltaOf(both, both), undefined);
});
