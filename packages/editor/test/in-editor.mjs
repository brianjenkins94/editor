/**
 * The tests that run in the editor (test/in-editor/): each spec written into a real editor's workspace, and run by its
 * debugger, where it drives an editor of its own in a preview window, as a person uses it. This only starts them and
 * says how they went: what they test is theirs.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/in-editor.mjs
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, before, test } from "node:test";

import { startSession } from "./architecture-harness.mjs";

let session;
const FOLDER = new URL("in-editor/", import.meta.url);
const SPECS = fs.readdirSync(FOLDER).filter((file) => file.endsWith(".spec.mjs"));

before(async () => {
	session = await startSession();

	for (const file of fs.readdirSync(FOLDER)) {
		await session.request("files.write", { "path": `in-editor/${file}`, "content": fs.readFileSync(new URL(file, FOLDER), "utf8") }, 30_000);
	}
});

after(async () => {
	await session?.close("in-editor");
});

/** A spec, run to its end in the editor's debugger. */
async function ran(spec) {
	const started = Date.now();
	let answer = await session.request("tests.run", { "files": [`in-editor/${spec}`] }, 120_000);

	for (let asked = 1; answer.running !== undefined && asked < 20; asked += 1) {
		answer = await session.request("tests.run", { "run": answer.run }, 120_000);
	}

	console.log(`${spec}: ${String(Date.now() - started)} ms`);

	return answer.files[0];
}

for (const spec of SPECS) {
	test(spec, async () => {
		const file = await ran(spec);

		assert.deepEqual(file.tests.filter(({ outcome }) => outcome !== "pass").map(({ id, error }) => `${id}: ${error}`), []);
		assert.ok(file.tests.length > 0, "it ran something");
	});
}
