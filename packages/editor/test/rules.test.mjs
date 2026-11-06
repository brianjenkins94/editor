/**
 * What a rule about a call can cover (editor-api's scopesOf), the picker's choices.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { scopesOf } from "@brianjenkins94/editor-api/rules";
import { ruleMatches } from "@brianjenkins94/util/silo/policy";

const labels = (capability, resource) => scopesOf(capability, resource).map(({ label }) => label);
const covers = (scope, capability, resource) => ruleMatches({ "when": scope.when, "then": [{ "action_id": "allow" }] }, { capability, resource });

test("a path can be covered by itself, each folder it's in, or every call", () => {
	assert.deepEqual(labels("fs:write", "/workspace/out/a.txt"), ["Just /workspace/out/a.txt", "/workspace/out/**", "/workspace/**", "Every fs:write call"]);
});

test("an address by its site, and a command by its program", () => {
	assert.deepEqual(labels("net", "https://example.com/a/b?c=d"), ["Just https://example.com/a/b?c=d", "https://example.com/**", "Every net call"]);
	assert.deepEqual(labels("exec", "npm run build"), ["Just npm run build", "npm **", "Every exec call"]);
	assert.deepEqual(labels("exec", "ls"), ["Just ls", "Every exec call"]);
});

test("a call whose resource isn't known yet can only be covered by every call of it", () => {
	assert.deepEqual(labels("fs:write"), ["Every fs:write call"]);
	assert.deepEqual(labels("fs:write", ""), ["Every fs:write call"]);
});

test("each scope covers the call it was made from, and only what it says", () => {
	const scopes = scopesOf("fs:write", "/workspace/out/a.txt");

	for (const scope of scopes) {
		assert.equal(covers(scope, "fs:write", "/workspace/out/a.txt"), true, scope.label);
		assert.equal(covers(scope, "fs:read", "/workspace/out/a.txt"), false, scope.label);
	}

	assert.equal(covers(scopes[1], "fs:write", "/workspace/out/b/c.txt"), true);
	assert.equal(covers(scopes[1], "fs:write", "/workspace/other.txt"), false);
	assert.equal(covers(scopes[2], "fs:write", "/workspace/other.txt"), true);
	assert.equal(covers(scopes[0], "fs:write", "/workspace/out/b.txt"), false);
});
