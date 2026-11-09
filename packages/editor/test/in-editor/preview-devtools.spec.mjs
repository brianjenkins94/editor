/**
 * Preview DevTools (shell/preview-devtools.ts), as a person has it: the DevTools button in a preview window's title bar docks
 * Chrome's DevTools under its page, which goes on running, and closes it again. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { devApp, openEditor, openTerminal, previewWindows } from "./editor.mjs";

test("a preview window's DevTools button docks DevTools under its page, talking to it, and closes it", async ({ page }) => {
	const workbench = await openEditor(page, devApp("toolsapp", "inspected"));
	const { input } = await openTerminal(workbench);

	await input.pressSequentially("cd toolsapp && vite\n");

	const shown = previewWindows(page);
	const app = shown.frameLocator("iframe[title^='Preview']");

	await expect(app.locator("#app")).toHaveText("inspected", { "timeout": 90_000 });

	await shown.locator("[aria-label='DevTools']").click();

	// Docked under the page, which keeps some of its room (the window grows by it, as far as the page below allows).
	const devtools = shown.locator("iframe[title='DevTools']");

	await expect(devtools).toBeVisible();

	const [frame, docked] = [await shown.locator("iframe[title^='Preview']").boundingBox(), await devtools.boundingBox()];

	expect(frame.height).toBeGreaterThan(100);
	expect(docked.y).toBeGreaterThanOrEqual(frame.y + frame.height - 1);
	await expect(shown.locator("[aria-label='Close DevTools']")).toBeVisible();

	// Talking to the page: what answers it (chobitsu) is added to the page as DevTools first asks.
	await expect(app.locator("script[src*='chobitsu']")).toBeAttached({ "timeout": 60_000 });
	await expect(app.locator("#app")).toHaveText("inspected");

	await shown.locator("[aria-label='Close DevTools']").click();
	await expect(devtools).toHaveCount(0);
});
