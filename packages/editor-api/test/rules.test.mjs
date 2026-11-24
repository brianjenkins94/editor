// Rules as they're read and made (rules.ts): a rule as a sentence in silo's catalog's words, a place in the code as words,
// and what a rule about a call can cover.
import * as assert from "node:assert/strict";
import { test } from "node:test";

import * as policy from "@brianjenkins94/util/silo/policy";

import { catalogOf, describeRule, sayPlace, scopesOf } from "../src/rules.ts";

const catalog = catalogOf(policy);
const is = (target, argument) => ({ "target_id": target, "operator_id": "is", "argument": argument });

test("a rule as a sentence: its rows joined as its logic says, nested ones bracketed, then what it does", () => {
	assert.equal(describeRule({ "when": { "logicalType_id": "all", "predicates": [is("capability", "fs:write"), { "target_id": "resource", "operator_id": "matches", "argument": "/workspace/**" }] }, "then": [{ "action_id": "allow" }] }, catalog), "capability is fs:write and resource matches /workspace/** → allow");
	assert.equal(describeRule({ "when": { "logicalType_id": "all", "predicates": [is("capability", "fs:write"), { "logicalType_id": "any", "predicates": [is("resource", "/a"), is("resource", "/b")] }] }, "then": [{ "action_id": "deny" }] }, catalog), "capability is fs:write and (resource is /a or resource is /b) → deny");
	assert.equal(describeRule({ "when": { "logicalType_id": "none", "predicates": [is("capability", "net"), is("capability", "net.ws")] }, "then": [{ "action_id": "allow" }] }, catalog), "not (capability is net or capability is net.ws) → allow");
	assert.equal(describeRule({ "when": { "logicalType_id": "any", "predicates": [] }, "then": [{ "action_id": "deny" }] }, catalog), "never → deny", "no row of any: it never applies");
	assert.equal(describeRule({ "when": { "logicalType_id": "all", "predicates": [] }, "then": [{ "action_id": "ask" }] }, catalog), "always → ask");
});

test("a rule about a place in the code says the place, and what it gives a command line as typed", () => {
	const at = { "file": "run.js", "shape": { "atoms": ["spawn", "(", "cmd", ")", ";"] } };

	assert.equal(describeRule({ "when": { "logicalType_id": "all", "predicates": [is("capability", "exec"), is("at", at)] }, "then": [{ "action_id": "give", "target_id": "process.argv", "argument": [["node", "a b.js"], ["node", "--watch"]] }] }, catalog), "capability is exec and at is run.js: spawn(cmd); → give process.argv node \"a b.js\" · node --watch");
});

test("a place in the code as words: a call's and an index's brackets on their name, a keyword's spaced, long code cut", () => {
	const place = (...atoms) => sayPlace({ "file": "tax.js", "shape": { "atoms": atoms } });

	assert.equal(place("const", "rate", "=", "rates", "[", "country", "]", "??", "0", ";"), "tax.js: const rate = rates[country] ?? 0;");
	assert.equal(place("if", "(", "ok", ")", "return", "[", "a", ",", "b", "]", ";"), "tax.js: if (ok) return [a, b];");
	assert.equal(place("total", "(", ")", ".", "then", "(", "show", ")", ";"), "tax.js: total().then(show);");
	assert.equal(place(...Array.from({ "length": 30 }, () => "word")).length, "tax.js: ".length + 60, "60 characters at most, the last an ellipsis");
	assert.equal(sayPlace(undefined), "?: ");
});

test("what a rule about a call can cover, narrowest first: just it, each folder or its site or its program's, every call", () => {
	const labels = (capability, resource) => scopesOf(capability, resource).map(({ label }) => label);

	assert.deepEqual(labels("fs:write", "/workspace/src/a.ts"), ["Just /workspace/src/a.ts", "/workspace/src/**", "/workspace/**", "Every fs:write call"]);
	assert.deepEqual(labels("net", "https://example.com/x?y"), ["Just https://example.com/x?y", "https://example.com/**", "Every net call"]);
	assert.deepEqual(labels("exec", "git status --short"), ["Just git status --short", "git **", "Every exec call"]);
	assert.deepEqual(labels("exec", "ls"), ["Just ls", "Every exec call"], "a command with no arguments: nothing between");
	assert.deepEqual(labels("env"), ["Every env call"]);

	// (each a rule's `when`: the capability, and the resource as the label says)
	const [just, folder, , every] = scopesOf("fs:write", "/workspace/src/a.ts");

	assert.deepEqual(just.when.predicates, [is("capability", "fs:write"), is("resource", "/workspace/src/a.ts")]);
	assert.deepEqual(folder.when.predicates[1], { "target_id": "resource", "operator_id": "matches", "argument": "/workspace/src/**" });
	assert.deepEqual(every.when, { "logicalType_id": "all", "predicates": [is("capability", "fs:write")] });
});
