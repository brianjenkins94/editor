/**
 * A reload, as a person does it: the file that was open comes back open, showing its text, not "the file was not found": VS Code
 * restores its tabs as it boots, each read once, so the workspace is mounted first. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, openFile, retype, runCommand } from "./editor.mjs";

/** How long VS Code takes to keep which tabs are open: a frame's reload doesn't wait for it, as a page's does. */
const TABS_KEPT_MS = 6000;

test("the open file comes back as it was saved", async ({ page }) => {
	const workbench = await openEditor(page, { "kept.mjs": "const kept = 1;\n", "other.mjs": "const other = 2;\n" });
	const comesBack = async () => {
		await expect(workbench.locator(".tab.active")).toContainText("kept.mjs", { "timeout": 120_000 });
		await expect(workbench.locator(".view-lines").first()).toContainText("const kept = 2;", { "timeout": 30_000 });
	};

	await openFile(workbench, "kept.mjs");
	await retype(workbench, "const kept = 2;\n");
	await page.waitForTimeout(TABS_KEPT_MS);

	// The page opened again; and again, what it kept being what it kept.
	for (const time of [1, 2]) {
		await page.goto(`${await page.url()}&again=${String(time)}`);
		await comesBack();
		await page.waitForTimeout(TABS_KEPT_MS);
	}

	// And VS Code's own command.
	await runCommand(workbench, "Developer: Reload Window");
	await page.waitForTimeout(3000);
	await comesBack();
});
