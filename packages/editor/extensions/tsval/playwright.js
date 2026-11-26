/**
 * `playwright`, the library, as a program run in the editor has it: a browser launched is the editor, and each page a
 * preview window of its own, driven by packages/playwright (the debug worker's `__editorPlaywright`, as @playwright/test's
 * pages are: playwright-test.js). A page's `colorScheme` is its window's frame's, so the page's `prefers-color-scheme`
 * follows it.
 *
 * What's here: `chromium` (and `firefox`, `webkit`, the same editor), `launch()`, a browser's `newPage(options)`,
 * `newContext(options)` and its `newPage()`, `close()`; a page's locators, `goto`, `url`, `title`, `evaluate`,
 * `waitForSelector`, `click`, `textContent`, `on("pageerror")`, `close`, and `expect`'s matchers on its locators. Not
 * here: other options than `colorScheme`, `connect`, `launchPersistentContext`, routes, screenshots and downloads.
 */
"use strict";

/** The debug worker's (absent elsewhere). */
const host = globalThis.__editorPlaywright;

const outside = () => new Error("playwright runs in the editor's debugger, its pages in preview windows: there's no browser here");

/** A page's options, as the editor takes them. */
function pageOptions(options = {}) {
	return options.colorScheme === undefined ? {} : { "colorScheme": options.colorScheme };
}

function context(defaults = {}) {
	const pages = new Set();

	return {
		"newPage": async (options = {}) => {
			if (host === undefined) {
				throw outside();
			}

			const page = host.page(pageOptions({ ...defaults, ...options }));

			pages.add(page);

			return page;
		},
		"pages": () => [...pages],
		"close": async () => {
			await Promise.all([...pages].map(async (page) => page.close()));
			pages.clear();
		}
	};
}

function browserType(name) {
	return {
		"name": () => name,
		"launch": async () => {
			if (host === undefined) {
				throw outside();
			}

			const contexts = new Set();
			const own = context();

			contexts.add(own);

			return {
				"newPage": own.newPage,
				"newContext": async (options = {}) => {
					const made = context(options);

					contexts.add(made);

					return made;
				},
				"contexts": () => [...contexts],
				"version": () => "editor",
				"isConnected": () => true,
				"close": async () => {
					await Promise.all([...contexts].map(async (each) => each.close()));
					contexts.clear();
				}
			};
		}
	};
}

const chromium = browserType("chromium");

module.exports = {
	"chromium": chromium,
	"firefox": browserType("firefox"),
	"webkit": browserType("webkit"),
	"expect": host === undefined ? () => { throw outside(); } : host.expect
};
