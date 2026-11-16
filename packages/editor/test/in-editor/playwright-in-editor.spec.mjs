/**
 * A Playwright test file run in the editor's debugger (packages/playwright, extensions/tsval/playwright-test.js), as a person
 * has it: an app served from the terminal, its spec run from Features and tests, each of its tests' outcomes there, and what
 * the test did, done in the window that's open; with no window open, a test that needs one fails rather than hanging. (A test
 * driving a whole editor in a window of its own, apart from the one it runs in, is what every spec here is: instances.spec
 * holds them apart.) Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, openTerminal, previewWindows, READABLE_TERMINAL, runCommand } from "./editor.mjs";

const spec = (body) => `import { expect, test } from "@playwright/test";\n\n${body}\n`;
const LEDGER = {
	"The app": { "status": "active", "why": "An app to test.", "since": "2026-11-16", "what": "An app to test.", "tests": ["pwapp/app.spec.mjs", "pwapp/none.spec.mjs"] }
};
const files = {
	...READABLE_TERMINAL,
	".silo/features.json": JSON.stringify(LEDGER, null, 2) + "\n",
	"pwapp/index.html": "<!doctype html><html><body><h1>App</h1><button>not yet</button><script type=\"module\" src=\"/src/main.ts\"></script></body></html>\n",
	// (it says it's there on the button, so nothing clicks before it listens)
	"pwapp/src/main.ts": "let count = 0;\nconst button = document.querySelector(\"button\")!;\n\nbutton.textContent = \"ready\";\nbutton.addEventListener(\"click\", () => {\n\tcount += 1;\n\tbutton.textContent = \"clicked \" + String(count);\n});\n",
	"pwapp/app.spec.mjs": spec([
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
		"});"
	].join("\n")),
	"pwapp/none.spec.mjs": spec("test(\"needs a page\", async ({ page }) => {\n\tawait expect(page.getByRole(\"button\")).toBeVisible({ \"timeout\": 500 });\n});")
};

test("a spec run from Features and tests drives the window that's open, and with none open fails rather than hangs", async ({ page }) => {
	const workbench = await openEditor(page, files);
	const row = (text) => workbench.locator(".fv-table tbody tr", { "hasText": text });
	// (its feature's row: its tests' ids begin with "the app" too)
	const feature = workbench.locator(".fv-table tbody tr.fv-feature", { "hasText": "The app" });
	const run = async (file) => row(file).locator(`wa-button[aria-label='Run pwapp/${file}']`).click();

	// The app, served: its window open, its page ready.
	const terminal = await openTerminal(workbench);

	await terminal.input.pressSequentially("cd pwapp && vite\n");

	const button = page.frameLocator("app-window[data-preview-port] iframe").locator("button");

	await expect(button).toHaveText("ready", { "timeout": 90_000 });

	// Its spec, run: one test passes, one fails, each said; and what the passing one did is in the window. (The terminal's
	// panel and the side bar out of the way first, for the view's room beside the app's window: the server goes on.)
	await runCommand(workbench, "View: Hide Panel");
	await runCommand(workbench, "View: Toggle Primary Side Bar Visibility");
	await runCommand(workbench, "Features and Tests: Show");
	await expect(row("app.spec.mjs")).toContainText("UI spec", { "timeout": 30_000 });
	await run("app.spec.mjs");
	await expect(feature).toContainText("1 failing", { "timeout": 120_000 });
	await row("app.spec.mjs").locator(".fv-toggle").click();
	await expect(row("its button counts")).not.toContainText("fail");
	await expect(row("isn't there")).toContainText("fail");
	await expect(button).toHaveText("clicked 1");

	// Stopped, its window goes; a spec that needs one then fails, rather than waiting for ever.
	const second = await openTerminal(workbench);

	await second.input.pressSequentially("ps\n");

	const served = second.output.locator("div", { "hasText": /running\s+service\s+5173/u });

	await expect(served).toBeVisible({ "timeout": 15_000 });

	const [id] = (await served.textContent()).trim().split(/\s+/u);

	await second.input.pressSequentially(`kill ${id}\n`);
	await expect(previewWindows(page)).toHaveCount(0, { "timeout": 30_000 });
	await runCommand(workbench, "View: Hide Panel");
	await runCommand(workbench, "Features and Tests: Show");
	await run("none.spec.mjs");
	await expect(feature).toContainText("2 failing", { "timeout": 120_000 });
});
