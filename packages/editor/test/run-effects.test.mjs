/**
 * A run's effects (extensions/bridge/capabilities/run-effects.ts): what the editor decided itself and what a debugger tells,
 * kept apart while the run goes and merged as its envelope takes them.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { recordEffect, setEffects, takeEffects } from "../shared/capabilities/run-effects.ts";

test("the editor's and the debugger's effects, together — a telling replaces only the debugger's", () => {
	recordEffect("run-1", "fs:read", "/workspace/a.txt", "made");
	recordEffect("run-1", "fs:read", "/workspace/a.txt", "made");
	setEffects("run-1", [{ "capability": "net", "resource": "https://example.com", "how": "denied", "calls": 1 }]);
	// (each telling has them all: this one's in place of the last, and the editor's stay)
	setEffects("run-1", [{ "capability": "net", "resource": "https://example.com", "how": "denied", "calls": 2 }, { "capability": "fs:read", "resource": "/workspace/a.txt", "how": "made", "calls": 1 }]);

	assert.deepEqual(takeEffects("run-1"), [
		{ "capability": "fs:read", "resource": "/workspace/a.txt", "how": "made", "calls": 3 },
		{ "capability": "net", "resource": "https://example.com", "how": "denied", "calls": 2 }
	]);
	assert.deepEqual(takeEffects("run-1"), [], "taken, they're gone");
});
