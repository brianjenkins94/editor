// The shell's extension point (shell/feature.ts): a store its features share — set by a patch or from what it is, heard
// by whoever listens until they stop — and what they share to begin with.
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { createStore, errText, shared, statusOf } from "../shell/feature.ts";

test("a store is set by a patch, or from what it is, and heard until its listener stops", () => {
	const store = createStore({ "count": 0, "name": "a" });
	const heard = [];
	const off = store.subscribe(() => {
		heard.push(store.get());
	});

	store.set({ "count": 1 });
	store.set((now) => ({ "count": now.count + 1 }));
	off();
	store.set({ "name": "b" });

	assert.deepEqual(heard, [{ "count": 1, "name": "a" }, { "count": 2, "name": "a" }]);
	assert.deepEqual(store.get(), { "count": 2, "name": "b" });
});

test("what the shell's features share starts signed out, with no repository, the GitHub popover closed", () => {
	assert.deepEqual(shared.get(), { "githubOpen": false });
});

test("a failure said: an Error's message, anything else as it is; a status when it has one", () => {
	assert.equal(errText(new Error("no")), "no");
	assert.equal(errText("refused"), "refused");
	assert.equal(statusOf({ "status": 404 }), 404);
	assert.equal(statusOf(new Error("no")), undefined);
});
