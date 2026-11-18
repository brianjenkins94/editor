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
import { execSync } from "node:child_process";
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

/** How long a spec may run: the slowest that passes takes under 30 s (2026-11-17), and a stall waited out 20 asks of 2 minutes
 *  each — or, the page crashed, for ever (2026-11-17: 2 h 40 min on playwright-in-editor.spec). */
const SPEC_MS = Number(process.env.IN_EDITOR_SPEC_MS ?? 300_000);

/** A spec, run to its end in `session`'s editor's debugger. */
async function ran(session, spec) {
	const started = Date.now();
	let answer = await session.request("tests.run", { "files": [`in-editor/${spec}`] }, 120_000);

	// (asked again while it runs, until SPEC_MS: a stall fails here, saying where it was, rather than holding every spec after it)
	while (answer.running !== undefined && Date.now() - started < SPEC_MS) {
		answer = await session.request("tests.run", { "run": answer.run }, 120_000);
	}

	console.log(`${spec}: ${String(Date.now() - started)} ms${await heapOf(session)}`);

	// What each test's editor was left with (workbench/effects.ts): the inventory of which can't share one.
	for (const each of answer.files?.[0]?.tests ?? []) {
		if (each.leaves !== undefined) {
			console.log(`[leaves] ${JSON.stringify({ "test": each.id, "leaves": each.leaves })}`);
		}
	}

	if (answer.running !== undefined) {
		return { "tests": [], "error": `still running after ${String(SPEC_MS / 1000)} s: ${answer.running}` };
	}

	return answer.files[0];
}

/** IN_EDITOR_HEAP=1: the renderer's JS heap as each spec ends (every editor on the page shares it) — what a spec leaves an
 *  editor that's shared, and whether a reset gives it back. */
const HEAP = process.env.IN_EDITOR_HEAP === "1";
const cdp = new WeakMap();

async function heapOf(session) {
	if (!HEAP) {
		return "";
	}

	if (!cdp.has(session)) {
		const client = await session.page.context().newCDPSession(session.page);

		await client.send("Performance.enable");
		cdp.set(session, client);
	}

	const { metrics } = await cdp.get(session).send("HeapProfiler.collectGarbage").then(async () => cdp.get(session).send("Performance.getMetrics"));
	const used = metrics.find(({ name }) => name === "JSHeapUsedSize")?.value ?? 0;
	// (the renderers as the system has them: their workers' heaps and buffers too, which the page's own heap doesn't count)
	const renderers = execSync("ps -A -o rss=,command=", { "encoding": "utf8" }).split("\n").filter((line) => line.includes("--type=renderer") && line.includes("ms-playwright")).map((line) => Number(line.trim().split(/\s+/u)[0]) * 1024);

	return `, heap ${String(Math.round(used / 1024 / 1024))} MB, renderers ${renderers.map((bytes) => String(Math.round(bytes / 1024 / 1024))).join("+")} MB`;
}

/** `work`, or undefined once `ms` pass: what's asked of a page that may have crashed (a frame's evaluate waits for ever). */
async function within(work, ms) {
	let timer;

	return Promise.race([work, new Promise((resolve) => { timer = setTimeout(resolve, ms); })]).finally(() => { clearTimeout(timer); });
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

/** The windows a failed spec's tests left open (test windows: no server's), closed by their Close once what they showed is
 *  said: each holds a whole editor, and three left open crashed a session's renderer (2026-11-18). Only one spec at a time,
 *  when every test window open is the failed spec's. */
async function closeLeftOpen(session) {
	const close = session.page.locator("app-window[data-preview-port='0']").locator(".app-window-controls [title='Close'], .app-window-controls [aria-label='Close']");

	for (let left = await close.count(); left > 0; left -= 1) {
		await close.first().click({ "timeout": 5000 }).catch(() => undefined);
	}
}

/** How many specs run at once: each has an editor of its own in a window of its own, all in one renderer process (they're
 *  the page's same-origin frames). One since 2026-11-18: two at once (since 2026-11-09, when three crashed near 9 GB) held
 *  two editors live in that renderer, 5.6–7.3 GB between specs, and a session of twelve crashed near 9 in 3 runs of 5; and
 *  beside each other some specs took ten times as long (commit-beside, dependency-baseline). One at a time, all 43 ran in
 *  one session, peaking at 5.1 GB, in 351 s against 266 (NEXT.md item 2, *Specs share an editor*). */
const AT_ONCE = Number(process.env.IN_EDITOR_AT_ONCE ?? 1);
/** How many specs a session runs before the next one starts afresh (a browser's start and the outer editor's boot each
 *  time): all of them, one at a time leaving the renderer nothing that grows. Eight, two at once. */
const BATCH = Number(process.env.IN_EDITOR_BATCH ?? (SPECS.length || 1));
/** How many sessions run at once, each its own browser (and so its own renderer, where ~9 GB is the limit: two specs at once in
 *  one crashed it, 2026-11-18), taking specs from one queue. */
const SESSIONS = Number(process.env.IN_EDITOR_SESSIONS ?? 1);
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
		// (one queue: each session takes the next spec as it's free, so a slow spec holds only its own)
		const queue = [...SPECS];

		void (async () => {
			await Promise.all(Array.from({ "length": SESSIONS }, async () => {
				while (queue.length > 0) {
					let session;
					let taken = 0;

					try {
						session = await sessionWithSpecs();
						await Promise.all(Array.from({ "length": AT_ONCE }, async () => {
							while (queue.length > 0 && taken < BATCH) {
								const spec = queue.shift();

								taken += 1;

								const file = await ran(session, spec).catch((error) => ({ "tests": [], "error": String(error) }));

								if (failed(file)) {
									await within(sayWhatHappened(session).catch(() => undefined), 15_000);

									if (AT_ONCE === 1) {
										await within(closeLeftOpen(session).catch(() => undefined), 30_000);
									}
								}

								settled.get(spec).finish(file);
							}
						}));
					} catch (error) {
						// (a session that didn't start: the batch it would have run says so)
						for (const spec of queue.splice(0, BATCH - taken)) {
							settled.get(spec).finish({ "tests": [], "error": `its session didn't start: ${String(error)}` });
						}
					} finally {
						await within(session?.close("in-editor").catch(() => undefined), 30_000);
					}
				}
			}));

			console.log(`all specs, ${String(SESSIONS)} sessions, ${String(AT_ONCE)} at once in each, ${String(BATCH)} a session: ${String(Date.now() - started)} ms`);
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
