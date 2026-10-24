/**
 * The gate (src/gate.ts): how a program's call goes by the policy — the rule tsval's interpreter and
 * the runtime's files (any debugger's) both decide by.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { recordingKey, requestOf, verdictOf } from "../src/gate.ts";

/** A policy of one rule: `action` for `capability` on `resource`. */
function policyOf(capability, resource, action) {
	return { "version": 1, "rules": [{ "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": capability }, { "target_id": "resource", "operator_id": "is", "argument": resource }] }, "then": [{ "action_id": action }] }] };
}

test("the policy decides: allowed, skipped or refused — and refused when it doesn't say", () => {
	assert.equal(verdictOf(policyOf("fs:write", "/workspace/out.txt", "allow"), "fs:write", "/workspace/out.txt"), "allow");
	assert.equal(verdictOf(policyOf("fs:write", "/workspace/out.txt", "skip"), "fs:write", "/workspace/out.txt"), "skip");
	assert.equal(verdictOf(policyOf("fs:write", "/workspace/out.txt", "deny"), "fs:write", "/workspace/out.txt"), "deny");
	assert.equal(verdictOf(policyOf("fs:write", "/workspace/out.txt", "allow"), "fs:write", "/workspace/other.txt"), "deny", "a call no rule decides");
	assert.equal(verdictOf(undefined, "fs:read", "/workspace/a.txt"), "deny", "no policy at all");
});

test("a live run makes nothing but a read the policy allows", () => {
	assert.equal(verdictOf(policyOf("fs:read", "/workspace/a.txt", "allow"), "fs:read", "/workspace/a.txt", true), "allow");
	assert.equal(verdictOf(policyOf("fs:write", "/workspace/a.txt", "allow"), "fs:write", "/workspace/a.txt", true), "skip", "an allowed write, skipped");
	assert.equal(verdictOf(policyOf("fs:read", "/workspace/a.txt", "deny"), "fs:read", "/workspace/a.txt", true), "skip", "a refused read, skipped rather than failing");
	assert.equal(verdictOf(undefined, "fs:read", "/workspace/a.txt", true), "skip", "a read nobody decided");
});

test("a recording is the whole request's: a POST's isn't given to a GET of the same URL", () => {
	const url = "https://api.example.test/orders";
	const keyOf = (...args) => recordingKey("net", url, requestOf("net", args));

	assert.equal(keyOf(url), `net ${url}`, "a plain read keys as it always has");
	assert.equal(keyOf(url, { "method": "head" }), `net ${url}`);
	assert.match(keyOf(url, { "method": "POST", "body": "{\"id\":1}" }), /^net https:\/\/api\.example\.test\/orders POST #[0-9a-f]{8}$/u);
	assert.notEqual(keyOf(url, { "method": "POST", "body": "{\"id\":1}" }), keyOf(url), "not a GET's");
	assert.notEqual(keyOf(url, { "method": "POST", "body": "{\"id\":1}" }), keyOf(url, { "method": "POST", "body": "{\"id\":2}" }), "nor another body's");
	assert.equal(keyOf(url, { "method": "POST", "body": "{\"id\":1}" }), keyOf(url, { "method": "post", "body": "{\"id\":1}" }), "the same request, the same key");
	assert.equal(keyOf({ "method": "DELETE", "url": url }), `net ${url} DELETE`, "a Request's method");
	assert.equal(requestOf("fs:read", ["/workspace/a.txt", { "method": "POST" }]), undefined, "only net calls have a request");
});
