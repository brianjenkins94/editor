/**
 * A test that launches a browser with `playwright` and serves its pages with vite's `preview()`, as example-consumer's
 * does, run with `node --test` in the editor's terminal: the browser is the editor, each page a preview window of its own
 * (extensions/tsval/playwright.js), the server its in-browser dev server (extensions/tsval/vite.js). A page's colorScheme is
 * what it sees as the system's, `evaluate` runs in it, and what it throws is a `pageerror`. Runs in the editor:
 * test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, openTerminal, READABLE_TERMINAL, runCommand } from "./editor.mjs";

const files = {
	...READABLE_TERMINAL,
	"site/index.html": "<!doctype html><html><head><title>Site</title></head><body><h1>Site</h1><button>close</button><p id=\"status\"></p><script type=\"module\" src=\"/main.js\"></script></body></html>\n",
	"site/main.js": "document.documentElement.className = matchMedia(\"(prefers-color-scheme: dark)\").matches ? \"dark\" : \"light\";\ndocument.querySelector(\"button\").addEventListener(\"click\", () => {\n\tdocument.querySelector(\"#status\").textContent = \"closed\";\n});\n",
	"site/broken.html": "<!doctype html><html><head></head><body><h1>Broken</h1><script type=\"module\">throw new Error(\"boom\");</script></body></html>\n",
	"site/test/pages.test.mjs": [
		"import assert from \"node:assert/strict\";",
		"import { after, before, test } from \"node:test\";",
		"import { chromium } from \"playwright\";",
		"import { preview } from \"vite\";",
		"",
		"let server;",
		"let browser;",
		"let base;",
		"",
		"before(async () => {",
		"\tserver = await preview({ \"preview\": { \"port\": 0 }, \"logLevel\": \"silent\" });",
		"\tbase = server.resolvedUrls.local[0];",
		"\tbrowser = await chromium.launch();",
		"});",
		"",
		"after(async () => {",
		"\tawait browser?.close();",
		"\tawait server?.close();",
		"});",
		"",
		"async function open(page, scheme) {",
		"\tconst tab = await browser.newPage({ \"colorScheme\": scheme });",
		"\tconst errors = [];",
		"",
		"\ttab.on(\"pageerror\", (error) => errors.push(error.message));",
		"\tawait tab.goto(new URL(page, base).href);",
		"\tawait tab.waitForSelector(\"h1\");",
		"",
		"\treturn { tab, errors };",
		"}",
		"",
		"test(\"light: its look, its button, nothing thrown\", async () => {",
		"\tconst { tab, errors } = await open(\"index.html\", \"light\");",
		"",
		"\tassert.equal(await tab.evaluate(() => document.documentElement.className), \"light\");",
		"\tawait tab.click(\"button\");",
		"\tassert.equal(await tab.textContent(\"#status\"), \"closed\");",
		"\tassert.deepEqual(errors, []);",
		"\tawait tab.close();",
		"});",
		"",
		"test(\"dark with the system\", async () => {",
		"\tconst { tab } = await open(\"index.html\", \"dark\");",
		"",
		"\tassert.equal(await tab.evaluate(() => document.documentElement.className), \"dark\");",
		"\tawait tab.close();",
		"});",
		"",
		"test(\"what it throws is heard\", async () => {",
		"\tconst { tab, errors } = await open(\"broken.html\", \"light\");",
		"",
		"\tassert.deepEqual(errors, [\"boom\"]);",
		"\tawait tab.close();",
		"});",
		""
	].join("\n")
};

test("node --test in the terminal: playwright's browser is preview windows, vite's preview the in-browser dev server", async ({ page }) => {
	const workbench = await openEditor(page, files);
	const { input, output } = await openTerminal(workbench);

	// (the panel as big as it goes: each test's line, and a failure's, on screen with the counts)
	await runCommand(workbench, "View: Toggle Maximized Panel");
	await input.pressSequentially("cd site && node --test test/pages.test.mjs\n");
	await expect(output).toContainText("ℹ tests 3", { "timeout": 180_000 });
	await expect(output).toContainText("ℹ pass 3");
	await expect(output).toContainText("ℹ fail 0");
});
