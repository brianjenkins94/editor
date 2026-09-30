import * as assert from "node:assert/strict";

import { test } from "node:test";
import { describeRealm } from "../src/arch.ts";
import { ArchitectureStore } from "../src/arch-store.ts";

/** Run `body` with `window` / `location` / `importScripts` stubbed. */
function withGlobals(stubs: Record<string, unknown>, body: () => void): void {
	const globals = globalThis as unknown as Record<string, unknown>;
	const saved = Object.fromEntries(Object.keys(stubs).map((key) => [key, globals[key]]));

	Object.assign(globals, stubs);

	try {
		body();
	} finally {
		Object.assign(globals, saved);
	}
}

test("a hub's realm: a page, a frame (with its parent's address), a worker, or nothing outside a browser", () => {
	assert.equal(describeRealm(), undefined, "Node");

	const top: { "parent"?: unknown; "location": { "href": string } } = { "location": { "href": "http://localhost/__virtual__/t/5173/" } };

	top.parent = top;
	withGlobals({ "window": top, "location": top.location }, () => {
		assert.deepEqual(describeRealm(), { "kind": "window", "url": "http://localhost/__virtual__/t/5173/" });
	});

	const frame = { "parent": top, "location": { "href": "http://localhost/__virtual__/t/5173/instance.html?id=client-0" } };

	withGlobals({ "window": frame, "location": frame.location }, () => {
		assert.deepEqual(describeRealm(), { "kind": "window", "url": frame.location.href, "parent": top.location.href });
	});
	withGlobals({ "window": undefined, "location": { "href": "http://localhost/__virtual__/t/5173/src/browser/referee.worker.ts" }, "importScripts": () => undefined }, () => {
		assert.deepEqual(describeRealm(), { "kind": "worker", "url": "http://localhost/__virtual__/t/5173/src/browser/referee.worker.ts" });
	});
});

test("the store keeps where each reporter runs", () => {
	const store = new ArchitectureStore();

	store.apply({ "reporter": "referee", "time": Date.now(), "realm": { "kind": "worker", "url": "http://localhost/referee.worker.ts" } });
	assert.deepEqual(store.realms.get("referee"), { "kind": "worker", "url": "http://localhost/referee.worker.ts" });
	assert.deepEqual((store.snapshot() as { "realms": Record<string, unknown> }).realms, { "referee": { "kind": "worker", "url": "http://localhost/referee.worker.ts" } });
});
