/**
 * The capability squiggles and the canary see the fs surface almostnode's runtime gate does — one table
 * (@brianjenkins94/almostnode/fs-capabilities), so no gated method goes unflagged statically.
 *
 *   node --import tsx --test test/capabilities.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { FS_ASYNC, FS_SYNC } from "@brianjenkins94/almostnode/fs-capabilities";
import ts from "typescript";

import { capabilityStandins } from "../extensions/capabilities/canary.ts";
import { classifyCall } from "../extensions/capabilities/capability-breakpoints.ts";

function call(source) {
	const file = ts.createSourceFile("x.ts", source, ts.ScriptTarget.Latest);
	let found;

	file.forEachChild(function visit(node) {
		found ??= ts.isCallExpression(node) ? node : undefined;
		node.forEachChild(visit);
	});

	return found;
}

test("every method almostnode gates is a capability call — including rm, rename, copyFile", () => {
	for (const [method, op] of Object.entries({ ...FS_SYNC, ...FS_ASYNC })) {
		assert.equal(classifyCall(call(`fs.${method}("/p")`), ["/p"])?.capability, "fs:" + op, method);
	}

	assert.deepEqual(classifyCall(call("fs.rmSync(\"/etc\")"), ["/etc"]), { "capability": "fs:write", "resource": "/etc", "callee": "fs.rmSync", "dangerous": true, "argIndex": 0 });
	assert.equal(classifyCall(call("renameSync(a, b)"), ["/a", "/b"])?.capability, "fs:write", "a destructured call too");
	assert.equal(classifyCall(call("fs.watch(\"/p\")"), ["/p"]), undefined, "an ungated method isn't one");
});

test("the canary stands in for every gated method, inertly", async () => {
	const fs = capabilityStandins().modules["node:fs"];

	for (const method of [...Object.keys(FS_SYNC), ...Object.keys(FS_ASYNC)]) {
		assert.equal(typeof fs[method], "function", method);
	}

	assert.equal(fs.existsSync("/p"), false);
	assert.deepEqual(await fs.readdir("/p"), []);
	assert.equal(await fs.readFile("/p"), "");
	assert.equal(await fs.rm("/p"), undefined);
	assert.equal(fs.copyFileSync("/a", "/b"), undefined);
});

test("identical decisions asked at once share one answer — one prompt, not one per request", async () => {
	const { coalesce } = await import("../extensions/capabilities/coalesce.ts");
	const answers = new Map();
	let asked = 0;
	const decide = coalesce((request) => request.scope, (request) => {
		asked += 1;

		return new Promise((resolve) => { answers.set(request.scope, resolve); });
	});
	// Six peer connections asking for net.webrtc:peer before the first answer, and one asking something else.
	const same = Array.from({ "length": 6 }, () => decide({ "scope": "net.webrtc:peer" }));
	const other = decide({ "scope": "net.ws:example.com" });

	assert.equal(asked, 2, "one decision per distinct question");
	answers.get("net.webrtc:peer")("allow");
	answers.get("net.ws:example.com")("deny");
	assert.deepEqual(await Promise.all(same), Array(6).fill("allow"));
	assert.equal(await other, "deny");

	// Answered, it's asked afresh next time (an "Allow once" is the broker's to remember, not this).
	const again = decide({ "scope": "net.webrtc:peer" });

	assert.equal(asked, 3);
	answers.get("net.webrtc:peer")("allow");
	assert.equal(await again, "allow");
});
