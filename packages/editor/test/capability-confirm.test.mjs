/**
 * Capabilities confirmed by runs (workbench/capability-confirm.ts): an allow rule no run has used, and whether the workspace's
 * own code could still make the call it allows — each code file's capabilities as lib's `detect` reads its text, a resource
 * never known, so a rule's row about the resource could go either way.
 *
 *   node --import tsx --test test/capability-confirm.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { callersOf, sayUnconfirmed } = await import("../workbench/capability-confirm.ts");

const is = (target, argument) => ({ "target_id": target, "operator_id": "is", "argument": argument });
const matches = (target, argument) => ({ "target_id": target, "operator_id": "matches", "argument": argument });
const allow = (when) => ({ "when": when, "then": [{ "action_id": "allow" }] });
const CODE = new Map([
	["fetches.mjs", ["net"]],
	["writes.mjs", ["fs:read", "fs:write"]],
	["runs.mjs", ["exec"]]
]);

test("the files that could make a call a rule allows: its capability's, whatever its resource", () => {
	assert.deepEqual(callersOf(allow({ "logicalType_id": "all", "predicates": [is("capability", "net"), matches("resource", "https://nobody.example/*")] }), CODE), ["fetches.mjs"]);
	assert.deepEqual(callersOf(allow({ "logicalType_id": "all", "predicates": [is("capability", "env"), matches("resource", "*")] }), CODE), []);
	// (a rule about the resource alone: any file that can do anything)
	assert.deepEqual(callersOf(allow(matches("resource", "/workspace/*")), CODE), ["fetches.mjs", "runs.mjs", "writes.mjs"]);
	assert.deepEqual(callersOf(allow({ "logicalType_id": "any", "predicates": [is("capability", "exec"), is("capability", "fs:write")] }), CODE), ["runs.mjs", "writes.mjs"]);
	assert.deepEqual(callersOf(allow({ "logicalType_id": "none", "predicates": [is("capability", "net")] }), CODE), ["runs.mjs", "writes.mjs"]);
});

test("what an unused rule says: none of the code can make the call, or which file can", () => {
	assert.match(sayUnconfirmed(6, []), /^No test run has used this allow rule: 6 kept since it was added, and none of the workspace's own code can make the call/u);
	assert.match(sayUnconfirmed(6, ["fetches.mjs", "other.mjs"]), /but fetches\.mjs and 1 more can make the call: a test that reaches it would confirm it\.$/u);
	assert.match(sayUnconfirmed(6, undefined), /Take it out if the code no longer needs it\.$/u);
});
