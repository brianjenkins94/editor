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

	console.log(`[in-editor] cancels: ${String(session.printed().filter((line) => line.startsWith("[cancel-probe]")).length)}`);
	return answer.files[0];
}

/** What's on screen in each frame still open, and what the page printed: why a spec failed on a runner nobody can watch. */
async function sayWhatHappened() {
	for (const frame of session.page.frames()) {
		const shown = await frame.evaluate(() => [...document.querySelectorAll(".tab, .notification-list-item, .monaco-dialog-box, .statusbar-item.left, .quick-input-widget:not([style*='display: none'])")].map((element) => `${element.className}: ${element.textContent.slice(0, 200)}`).filter((line) => !/: $/u.test(line))).catch(() => []);

		if (shown.some((line) => line.startsWith("tab "))) {
			console.log(`[in-editor] on screen in ${frame.url().slice(0, 100)}:\n  ${shown.join("\n  ")}`);
		}

		// (a tab still unsaved: whether saving again gets through, which tells a dropped save from one stuck in its queue)
		const again = await frame.evaluate(async () => {
			const { api } = globalThis.__editor ?? {};

			if (api === undefined || document.querySelector(".tab") === null) {
				return undefined;
			}

			if (document.querySelector(".tab.dirty") === null) {
				return "no tab unsaved";
			}

			const dirty = () => api.workspace.textDocuments.filter((document_) => document_.isDirty).map((document_) => document_.uri.path);
			const before = dirty();
			const saved = await Promise.race([api.workspace.saveAll(false), new Promise((resolve) => { setTimeout(() => { resolve("no answer in 20 s"); }, 20_000); })]);

			return { "before": before, "saved": saved, "after": dirty(), "stillShownDirty": document.querySelector(".tab.dirty") !== null };
		}).catch((error) => String(error));

		if (again !== undefined) {
			console.log(`[in-editor] saving again: ${JSON.stringify(again)}`);
		}
	}

	console.log(`[in-editor] cancellations:\n${[...new Set(session.printed().filter((line) => line.startsWith("[cancel-probe]") && !line.includes("UniqueContainer.value")).map((line) => line.replace(/^\[cancel-probe\] \d+ /u, "").slice(0, 1400)))].slice(-14).join("\n")}`);
	console.log(`[in-editor] printed:\n  ${session.printed().filter((line) => !/^\{"context|^%c|^console\.group|^\s*$|^[←→]|observability\.|node_modules|ata\.|\.cdn/u.test(line)).slice(-120).map((line) => line.slice(0, 220)).join("\n  ")}`);
}

for (const spec of SPECS) {
	test(spec, async () => {
		const file = await ran(spec);

		if (file.tests.length === 0 || file.tests.some(({ outcome }) => outcome !== "pass")) {
			await sayWhatHappened();
		}

		assert.deepEqual(file.tests.filter(({ outcome }) => outcome !== "pass").map(({ id, error }) => `${id}: ${error}`), []);
		assert.ok(file.tests.length > 0, file.stalled ?? file.output ?? "it ran something");
	});
}
