// An instance's own storage (shared/instance.ts): every name it uses is its own, and nothing else on the origin is in reach.
import assert from "node:assert/strict";
import { test } from "node:test";

import { anyInstance, instance, instanced, isolate, ownName } from "../shared/instance.ts";

/** An origin's IndexedDB and a Storage, as their prototypes are: `this` is the store. */
function origin() {
	const databases = new Map();
	const factory = {
		open(name, version) { databases.set(name, version); return name; },
		deleteDatabase(name) { databases.delete(name); return name; },
		async databases() { return [...databases.keys()].map((name) => ({ "name": name })); }
	};
	const proto = {
		getItem(key) { return this.items.has(key) ? this.items.get(key) : null; },
		setItem(key, value) { this.items.set(key, value); },
		removeItem(key) { this.items.delete(key); },
		clear() { this.items.clear(); }
	};

	return { databases, factory, proto, "store": Object.assign(Object.create(proto), { "items": new Map() }) };
}

const entries = (store) => [...store.items.keys()];

test("off a page, there's no instance", () => {
	assert.equal(instance, undefined);
});

test("an instance's databases are its own: named apart, and the others out of sight", async () => {
	const { databases, factory, proto } = origin();

	databases.set("workspace-fs", 1);
	databases.set(instanced("other", "workspace-fs"), 1);
	isolate("one", factory, proto, entries);

	assert.equal(factory.open("workspace-fs", 2), "instance:one:workspace-fs");
	assert.equal(databases.get("workspace-fs"), 1, "the real one untouched");
	assert.deepEqual(await factory.databases(), [{ "name": "workspace-fs" }], "only its own, as it names it");

	factory.deleteDatabase("workspace-fs");
	assert.deepEqual([...databases.keys()], ["workspace-fs", "instance:other:workspace-fs"], "deleting takes only its own");
});

test("an instance's keys are its own, and clearing takes only them", () => {
	const { factory, proto, store } = origin();

	store.items.set("shell:asideWidth", "real");
	store.items.set(instanced("other", "shell:asideWidth"), "other");
	isolate("one", factory, proto, entries);

	assert.equal(store.getItem("shell:asideWidth"), null, "the real one out of reach");
	store.setItem("shell:asideWidth", "mine");
	assert.equal(store.getItem("shell:asideWidth"), "mine");
	assert.equal(store.items.get("shell:asideWidth"), "real");

	store.clear();
	assert.equal(store.getItem("shell:asideWidth"), null);
	assert.deepEqual(entries(store).toSorted(), ["instance:other:shell:asideWidth", "shell:asideWidth"]);
});

test("a name says whose it is", () => {
	assert.equal(ownName("one", instanced("one", "a")), "a");
	assert.equal(ownName("one", instanced("other", "a")), undefined);
	assert.equal(ownName("one", "a"), undefined);
	assert.equal(anyInstance(instanced("one", "a")), true);
	assert.equal(anyInstance("workspace-fs"), false);
});
