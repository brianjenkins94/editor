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

/** What's on screen in each frame still open, and what the page printed: why a spec failed on a runner nobody can watch. */
async function sayWhatHappened() {
	for (const frame of session.page.frames()) {
		const shown = await frame.evaluate(() => [...document.querySelectorAll(".tab, .notification-list-item, .monaco-dialog-box, .statusbar-item.left, .quick-input-widget:not([style*='display: none'])")].map((element) => `${element.className}: ${element.textContent.slice(0, 200)}`).filter((line) => !/: $/u.test(line))).catch(() => []);

		if (shown.some((line) => line.startsWith("tab "))) {
			console.log(`[in-editor] on screen in ${frame.url().slice(0, 100)}:\n  ${shown.join("\n  ")}`);
		}
	}

	console.log(`[in-editor] printed:\n  ${session.printed().filter((line) => !/^\{"context|^%c|^console\.group|^\s*$|^[←→]|observability\.|node_modules|ata\.|\.cdn/u.test(line)).slice(-120).map((line) => line.slice(0, 220)).join("\n  ")}`);
}

/** How many specs run at once: each has an editor of its own in a window of its own. */
const AT_ONCE = Number(process.env.IN_EDITOR_AT_ONCE ?? 3);
/** COVERAGE=1 reads each test's counts around it (architecture-harness.mjs), so a spec is run in its test, one at a time, each
 *  with the page to itself. */
const COUNTING = process.env.COVERAGE === "1";
let answers;

/** Every spec's run, started once, `AT_ONCE` at a time: each test here awaits its own. */
function runs() {
	if (answers === undefined) {
		const left = [...SPECS];
		const settled = new Map(SPECS.map((spec) => {
			let finish;
			const promise = new Promise((resolve) => { finish = resolve; });

			return [spec, { "promise": promise, "finish": finish }];
		}));
		const started = Date.now();

		answers = settled;
		void Promise.all(Array.from({ "length": AT_ONCE }, async () => {
			while (left.length > 0) {
				const spec = left.shift();

				settled.get(spec).finish(await ran(spec).catch((error) => ({ "tests": [], "error": String(error) })));
			}
		})).then(() => {
			console.log(`all specs, ${String(AT_ONCE)} at once: ${String(Date.now() - started)} ms`);
		});
	}

	return answers;
}

async function closeWindows() {
	await session.page.evaluate(() => {
		for (const element of document.querySelectorAll("app-window[data-preview-port]")) {
			element.remove();
		}
	});
}

for (const spec of SPECS) {
	test(spec, async () => {
		// (the windows the spec before left, its counts read)
		if (COUNTING) {
			await closeWindows();
		}

		const file = COUNTING ? await ran(spec) : await runs().get(spec).promise;

		if (file.tests.length === 0 || file.tests.some(({ outcome }) => outcome !== "pass")) {
			await sayWhatHappened();
		}

		assert.deepEqual(file.tests.filter(({ outcome }) => outcome !== "pass").map(({ id, error }) => `${id}: ${error}`), []);
		assert.ok(file.tests.length > 0, file.stalled ?? file.error ?? file.output ?? "it ran something");
	});
}
