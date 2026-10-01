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
