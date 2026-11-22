/**
 * Documents opened, counted by who opened them (src/documents.ts): the function that asked, its paths and its time.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { countDocumentOpens } from "../src/documents.ts";

/** An API whose documents open as `{ uri }`, a beat later. */
function apiOf() {
	return { "workspace": { "openTextDocument": async (uri) => { await new Promise((resolve) => { setTimeout(resolve, 5); }); return { "uri": uri }; } } };
}

class Sweep {
	async walk(api, paths) {
		return Promise.all(paths.map(async (path) => api.workspace.openTextDocument({ "path": path })));
	}
}

async function textsOf(api, paths) {
	for (const path of paths) {
		await api.workspace.openTextDocument({ "path": path });
	}
}

test("each open is counted by the function that asked — a class's method as Class/method — with its distinct paths and time", async () => {
	const api = apiOf();
	let firsts = 0;
	const gauge = countDocumentOpens(api, () => { firsts += 1; });

	assert.equal(gauge(), undefined, "nothing opened yet");

	const opened = await api.workspace.openTextDocument({ "path": "/workspace/a.ts" });

	assert.deepEqual(opened, { "uri": { "path": "/workspace/a.ts" } }, "it still opens");
	await textsOf(api, ["/workspace/a.ts", "/workspace/b.ts", "/workspace/a.ts"]);
	await new Sweep().walk(api, ["/workspace/c.ts", "/workspace/d.ts"]);

	const values = gauge();

	assert.equal(firsts, 1, "told once, on the first");
	assert.equal(values["textsOf.opened"], 3);
	assert.equal(values["textsOf.paths"], 2);
	assert.ok(values["textsOf.ms"] >= 10, JSON.stringify(values));
	assert.equal(values["Sweep/walk.opened"], 2, JSON.stringify(values));
	assert.equal(Object.keys(values).filter((key) => key.endsWith(".opened")).reduce((sum, key) => sum + values[key], 0), 6, JSON.stringify(values));
});

test("an API counted already, or a frozen one, isn't counted again", () => {
	const api = apiOf();

	assert.notEqual(countDocumentOpens(api), undefined);
	assert.equal(countDocumentOpens(api), undefined, "counted already");
	assert.equal(countDocumentOpens({ "workspace": Object.freeze({ "openTextDocument": async () => undefined }) }), undefined, "frozen");
});
