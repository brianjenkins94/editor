/**
 * The tests that run in the editor (test/in-editor/): each spec written into a real editor's workspace, and run by its
 * debugger, where it drives an editor of its own in a preview window, as a person uses it. This only starts them and
 * says how they went: what they test is theirs. They run in batches, each in a session (a browser) of its own: every spec's
 * editor is a frame of the one page, so they share its renderer, which keeps what they used, freed or not (measured
 * 2026-11-10: about 60 MB a spec that never came back, the live JavaScript 0.8 GB at the end of a run that held 6.2), and
 * near 9 GB it crashes.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/in-editor.mjs
 */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import { after, before, test } from "node:test";

import { startSession } from "./architecture-harness.mjs";

const FOLDER = new URL("in-editor/", import.meta.url);
/** IN_EDITOR_ONLY=<part of a name>: only the specs it names, while writing one. */
const SPECS = fs.readdirSync(FOLDER).filter((file) => file.endsWith(".spec.mjs") && file.includes(process.env.IN_EDITOR_ONLY ?? ""));

/** A session with every spec written into its workspace. */
async function sessionWithSpecs() {
	const session = await startSession();

	for (const file of fs.readdirSync(FOLDER)) {
		await session.request("files.write", { "path": `in-editor/${file}`, "content": fs.readFileSync(new URL(file, FOLDER), "utf8") }, 30_000);
	}

	return session;
}

/** A spec, run to its end in `session`'s editor's debugger. */
async function ran(session, spec) {
	const started = Date.now();
	let answer = await session.request("tests.run", { "files": [`in-editor/${spec}`] }, 120_000);

	for (let asked = 1; answer.running !== undefined && asked < 20; asked += 1) {
		answer = await session.request("tests.run", { "run": answer.run }, 120_000);
	}

	console.log(`${spec}: ${String(Date.now() - started)} ms`);

	return answer.files[0];
}

/** What's on screen in each frame still open, and what the page printed: why a spec failed on a runner nobody can watch. */
async function sayWhatHappened(session) {
	for (const frame of session.page.frames()) {
		const shown = await frame.evaluate(() => [...document.querySelectorAll(".tab, .notification-list-item, .monaco-dialog-box, .statusbar-item.left, .quick-input-widget:not([style*='display: none'])")].map((element) => `${element.className}: ${element.textContent.slice(0, 200)}`).filter((line) => !/: $/u.test(line))).catch(() => []);

		if (shown.some((line) => line.startsWith("tab "))) {
			console.log(`[in-editor] on screen in ${frame.url().slice(0, 100)}:\n  ${shown.join("\n  ")}`);
		}
	}

	console.log(`[in-editor] printed:\n  ${session.printed().filter((line) => !/^\{"context|^%c|^console\.group|^\s*$|^[←→]|observability\.|node_modules|ata\.|\.cdn/u.test(line)).slice(-120).map((line) => line.slice(0, 220)).join("\n  ")}`);
}

/** How many specs run at once: each has an editor of its own in a window of its own, all in one renderer process (they're
 *  the page's same-origin frames). Two, not three (2026-11-09): at three its peak was 8.7 GB of all 29 specs and it
 *  crashed near 9 three times in four runs; at two, 7.5 GB, for 168 s against 154. */
const AT_ONCE = Number(process.env.IN_EDITOR_AT_ONCE ?? 2);
/** How many specs a session runs before the next one starts afresh: its renderer's peak, 2 at once, stays near 7 GB
 *  (2026-11-10), at a browser's start and the outer editor's boot each time. */
const BATCH = Number(process.env.IN_EDITOR_BATCH ?? 12);
/** COVERAGE=1 reads each test's counts around it (architecture-harness.mjs), so a spec is run in its test, one at a time, each
 *  with the page to itself, in one session. */
const COUNTING = process.env.COVERAGE === "1";
/** COVERAGE=1's one session, once it's started. */
const counting = { "session": undefined };
let answers;

/** Whether a spec's run failed (or ran nothing). */
const failed = (file) => file.tests.length === 0 || file.tests.some(({ outcome }) => outcome !== "pass");

/** Every spec's run, started once, a batch to a session and `AT_ONCE` at a time: each test here awaits its own. A
 *  failure says what was on screen while its session is open. */
function runs() {
	if (answers === undefined) {
		const settled = new Map(SPECS.map((spec) => {
			let finish;
			const promise = new Promise((resolve) => { finish = resolve; });

			return [spec, { "promise": promise, "finish": finish }];
		}));
		const started = Date.now();

		answers = settled;
		void (async () => {
			for (let first = 0; first < SPECS.length; first += BATCH) {
				const left = SPECS.slice(first, first + BATCH);
				let session;

				try {
					session = await sessionWithSpecs();
					await Promise.all(Array.from({ "length": AT_ONCE }, async () => {
						while (left.length > 0) {
							const spec = left.shift();
							const file = await ran(session, spec).catch((error) => ({ "tests": [], "error": String(error) }));

							if (failed(file)) {
								await sayWhatHappened(session).catch(() => undefined);
							}

							settled.get(spec).finish(file);
						}
					}));
				} catch (error) {
					// (a session that didn't start: its batch's specs say so)
					for (const spec of left.splice(0)) {
						settled.get(spec).finish({ "tests": [], "error": `its session didn't start: ${String(error)}` });
					}
				} finally {
					await session?.close("in-editor").catch(() => undefined);
				}
			}

			console.log(`all specs, ${String(AT_ONCE)} at once, ${String(BATCH)} a session: ${String(Date.now() - started)} ms`);
		})();
	}

	return answers;
}

before(async () => {
	if (COUNTING) {
		counting.session = await sessionWithSpecs();
	}
});

after(async () => {
	await counting.session?.close("in-editor");
});

async function closeWindows(session) {
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
			await closeWindows(counting.session);
		}

		const file = COUNTING ? await ran(counting.session, spec) : await runs().get(spec).promise;

		if (COUNTING && failed(file)) {
			await sayWhatHappened(counting.session);
		}

		assert.deepEqual(file.tests.filter(({ outcome }) => outcome !== "pass").map(({ id, error }) => `${id}: ${error}`), []);
		assert.ok(file.tests.length > 0, file.stalled ?? file.error ?? file.output ?? "it ran something");
	});
}
