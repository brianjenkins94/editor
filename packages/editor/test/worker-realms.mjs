/**
 * Every module the editor loads into a realm of its own loads there: started as its starter starts it (a worker importing
 * it, as an extension's bootstrap does), on the editor's origin, with only the globals its realm has — a worker's; and,
 * for an engine the TypeScript server loads, the server's `ts`, handed in as its plugin hands it (`globalThis.__<x>Ts`).
 * One that reads a global its realm lacks as it loads (util's env reads `process`) fails here, by name, with where it
 * threw — not as a debug run that never starts and a test that times out.
 *
 * Which chunk lands in which realm is the bundler's choice: a module shared by two entries becomes a chunk of its own,
 * loaded before either entry's own code (and before a shim at its top). This is what checks the outcome.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/worker-realms.mjs
 */
import assert from "node:assert/strict";
import * as path from "node:path";
import { after, before, test } from "node:test";
import * as fs from "@brianjenkins94/util/fs";
import { launchChromium } from "@brianjenkins94/util/playwright/chromium";

import { URL_UNDER_TEST } from "./architecture-harness.mjs";

/** What's built into dist/lsp that runs in a realm of its own: every entry, none of the chunks they share. The
 *  TypeScript server plugins aren't: they're CommonJS, loaded by tsserver into its own worker, where its tours run them. */
const LSP = path.join(import.meta.dirname, "../dist/lsp");
const ENTRIES = fs.readdirSync(LSP).filter((file) => /^[a-z]+(?:-[a-z]+)*\.js$/u.test(file) && !file.endsWith("-ts-plugin.js")).sort();
/** The TypeScript the build shares between its workers (a chunk of dist/lsp, and the export that gives it), to hand an
 *  engine as the TypeScript server hands it its own. */
const TYPESCRIPT = (() => {
	for (const file of ENTRIES) {
		const found = /import \{[^}]*\b(\w+) as require_typescript\b[^}]*\} from "\.\/(typescript-[\w-]+\.js)"/u.exec(fs.readFileSync(path.join(LSP, file)));

		if (found !== null) {
			return { "file": found[2], "export": found[1] };
		}
	}

	return undefined;
})();

/** How long one may take to load (the debug worker's TypeScript is megabytes; the cspell host starts its server). */
const LOAD_MS = 60_000;

let browser;
let page;

before(async () => {
	browser = await launchChromium({});
	page = await browser.newPage();
	// (any page of the editor's origin: its headers make it cross-origin isolated, as the editor is)
	await page.goto(new URL("__vscode__/lsp/", URL_UNDER_TEST).href);
});

after(async () => {
	await browser?.close();
});

test("the entries are found", () => {
	assert.ok(ENTRIES.includes("debug-worker.js") && ENTRIES.includes("packages-worker.js"), "dist/lsp has its entries: " + ENTRIES.join(", "));
});

/** Load `entry` as its starter does, in its realm: undefined when it loaded, else why it couldn't. */
async function load(entry) {
	const url = new URL("__vscode__/lsp/" + entry, URL_UNDER_TEST).href;
	// (an engine the TypeScript server loads: the `ts` globals it reads, set to TypeScript first)
	const handed = [...new Set(fs.readFileSync(path.join(LSP, entry)).match(/(?<=globalThis\.)__\w+Ts\b/gu) ?? [])];

	assert.ok(handed.length === 0 || TYPESCRIPT !== undefined, `${entry} is handed TypeScript, and dist/lsp has no TypeScript chunk to hand it`);

	const typescript = handed.length === 0 ? undefined : { "url": new URL("__vscode__/lsp/" + TYPESCRIPT.file, URL_UNDER_TEST).href, "export": TYPESCRIPT.export, "globals": handed };
	const outcome = await page.evaluate(({ url, typescript, timeoutMs }) => new Promise((resolve) => {
		const hand = typescript === undefined ? "" : `const ts = (await import(${JSON.stringify(typescript.url)}))[${JSON.stringify(typescript.export)}](); ${typescript.globals.map((name) => `globalThis.${name} = ts;`).join(" ")} `;
		const boot = `try { ${hand}await import(${JSON.stringify(url)}); postMessage({ "loaded": true }); } catch (error) { postMessage({ "failed": String(error && error.stack || error) }); }`;
		const worker = new Worker(URL.createObjectURL(new Blob([boot], { "type": "text/javascript" })), { "type": "module" });
		const done = (result) => {
			worker.terminate();
			resolve(result);
		};

		worker.addEventListener("message", (event) => {
			if (event.data?.loaded === true || typeof event.data?.failed === "string") {
				done(event.data);
			}
		});
		worker.addEventListener("error", (event) => {
			event.preventDefault();
			done({ "failed": `${event.message} (${event.filename}:${event.lineno})` });
		});
		setTimeout(() => {
			done({ "failed": `didn't finish loading in ${timeoutMs / 1000} s` });
		}, timeoutMs);
	}), { "url": url, "typescript": typescript, "timeoutMs": LOAD_MS });

	return outcome.failed;
}

for (const entry of ENTRIES) {
	test(`${entry} loads in a worker of its own`, async () => {
		const failed = await load(entry);

		assert.equal(failed, undefined, `${entry} couldn't load: ${failed}`);
	});
}
