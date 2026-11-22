/**
 * What of the code's use of a dependency can have grown (extensions/capabilities/resolved.ts, before lib's syncConsumer): a
 * use read while its package's version was still resolving had nothing to grow from.
 *
 *   node --import tsx --test test/baseline-resolved.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { syncConsumer } from "@brianjenkins94/util/silo/evidence";

const { resolvedSince } = await import("../extensions/capabilities/resolved.ts");

/** react's use in the root workspace: `version` (none while resolving), what it reaches. */
const use = (version, caps) => ({ ".": { "react": { "kind": "package", ...version === undefined ? {} : { "version": version }, "members": ["useState"], "dynamic": false, "caps": caps } } });

test("a use read before its version resolved starts at its first reading with one: nothing grown from none", () => {
	const before = use(undefined, []);
	const now = use("19.3.1", ["env", "net"]);

	// (as it was read: no version, then one, read as a version that moved, all it reaches grown)
	assert.deepEqual(syncConsumer(before, now).grew, [". react"], "without it, every capability grows");
	assert.deepEqual(syncConsumer(resolvedSince(before, now), now).grew, []);
	assert.equal(syncConsumer(resolvedSince(before, now), now).consumer["."].react.grew, undefined);
});

test("a use whose version was known, moved or not, is as it was: what it reaches now that it didn't still grows", () => {
	const before = use("19.3.0", ["env"]);
	const now = use("19.3.1", ["env", "net"]);

	assert.deepEqual(resolvedSince(before, now), before);
	assert.deepEqual(syncConsumer(resolvedSince(before, now), now).consumer["."].react.grew, { "net": "19.3.1" });
	assert.equal(resolvedSince(undefined, now), undefined, "no reading before: where it starts");
	assert.deepEqual(resolvedSince(use(undefined, []), use(undefined, [])), use(undefined, []), "still resolving: as it was");
});
