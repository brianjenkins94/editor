/**
 * In-editor Playwright (packages/playwright, extensions/tsval/playwright-test.js): a `@playwright/test` file runs in the
 * debugger against the preview you have open, each op run on its page by the shell: what the end goal rests on, every test
 * running in the editor, in the browser.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/playwright-in-editor.mjs
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startSession } from "./architecture-harness.mjs";

let session;

before(async () => {
	session = await startSession();
});

after(async () => {
	await session?.close("playwright-in-editor");
});

const pageCounts = "let count = 0;\nconst button = document.querySelector(\"button\")!;\n\nbutton.addEventListener(\"click\", () => {\n\tcount += 1;\n\tbutton.textContent = \"clicked \" + String(count);\n});\n";

/** Test files run as runs_tests does, to their end (a call answers within a minute: then the run, asked again). */
async function ran(files) {
	let answer = await session.request("tests.run", { "files": files }, 120_000);

	for (let asked = 1; answer.counts === undefined && answer.ask === undefined && typeof answer.run === "string" && asked < 10; asked++) {
		answer = await session.request("tests.run", { "run": answer.run }, 120_000);
	}

	return answer;
}

test("a test file in the debugger drives the preview you have open", async () => {
	await session.request("files.write", { "path": "pwapp/index.html", "content": "<!doctype html><html><body><h1>App</h1><button>not yet</button><script type=\"module\" src=\"/src/main.ts\"></script></body></html>\n" }, 30_000);
	await session.request("files.write", { "path": "pwapp/src/main.ts", "content": pageCounts }, 30_000);
	await session.terminal("cd pwapp && vite", { "fresh": true });
	await session.eventually("the window's page", async () => (await session.page.evaluate(() => document.querySelector("app-window[data-preview-port] iframe")?.contentDocument?.querySelector("h1")?.textContent ?? "")) === "App" || undefined, 90_000);
	await session.request("files.write", { "path": "pwapp/app.spec.mjs", "content": [
		"import { expect, test } from \"@playwright/test\";",
		"",
		"test.describe(\"the app\", () => {",
		"\ttest(\"its button counts\", async ({ page }) => {",
		"\t\tawait expect(page.getByRole(\"heading\", { \"level\": 1 })).toContainText(\"App\");",
		"\t\tconst button = page.getByRole(\"button\");",
		"\t\tconst before = await button.textContent();",
		"",
		"\t\tawait button.click();",
		"\t\tawait expect(button).not.toHaveText(before);",
		"\t});",
		"",
		"\ttest(\"isn't there\", async ({ page }) => {",
		"\t\tawait expect(page.getByText(\"Nothing like this\")).toBeVisible({ \"timeout\": 500 });",
		"\t});",
		"});",
		""
	].join("\n") }, 30_000);

	const { files: [file] } = await ran(["pwapp/app.spec.mjs"]);

	assert.deepEqual(file.tests.map(({ id, outcome }) => [id, outcome]), [["pwapp/app.spec.mjs › the app › its button counts", "pass"], ["pwapp/app.spec.mjs › the app › isn't there", "fail"]]);
	assert.match(file.tests[1].error, /toBeVisible\(\) failed/u, "what didn't hold");
	assert.equal(file.exitCode, 1);
	// It really happened in the page you have open.
	assert.equal(await session.page.evaluate(() => document.querySelector("app-window[data-preview-port] iframe").contentDocument.querySelector("button").textContent), "clicked 1");
});

test("with no window open, a test fails instead of hanging", async () => {
	await session.terminal("ps", { "fresh": true });

	const output = async () => (await session.request("terminal.state", { "lines": 60 }, 10_000)).map((each) => each.output).join("\n");
	const run = (await session.eventually("its run", async () => /^\s*(\S+)\s+running\s+service\s+\d+/mu.exec(await output()) ?? undefined, 30_000))[1];

	await session.terminal(`kill ${run}`);
	await session.eventually("no window", async () => (await session.page.locator("app-window[data-preview-port]").count()) === 0 || undefined, 30_000);
	await session.request("files.write", { "path": "pwapp/none.spec.mjs", "content": "import { expect, test } from \"@playwright/test\";\n\ntest(\"needs a page\", async ({ page }) => {\n\tawait expect(page.getByRole(\"button\")).toBeVisible({ \"timeout\": 500 });\n});\n" }, 30_000);

	const { files: [file] } = await ran(["pwapp/none.spec.mjs"]);

	// (it fails rather than hanging; what it says doesn't yet say why: an expect reports what it last read)
	assert.equal(file.tests[0].outcome, "fail");
	assert.match(file.tests[0].error, /toBeVisible\(\) failed/u);
});
