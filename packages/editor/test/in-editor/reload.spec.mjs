/**
 * A reload, as a person does it: the file that was open comes back open, showing its text, not "the file was not found": VS Code
 * restores its tabs as it boots, each read once, and the workspace is mounted after boot, so their reads wait for it (holdFiles). Runs in the
 * editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, openFile, retype, runCommand } from "./editor.mjs";

/** How long VS Code may take to keep which tabs are open, on a slow runner: a frame's reload doesn't wait for it, as a page's
 *  does, and it's kept nowhere a person could see. */
const TABS_KEPT_MS = 20_000;

test("the open file comes back as it was saved", async ({ page }) => {
	const workbench = await openEditor(page, { "kept.mjs": "const kept = 1;\n", "other.mjs": "const other = 2;\n" });
	/** The file open again, saying what's there if it isn't: under the run's own limit for silence, so this says it and not that. */
	const comesBack = async (after) => {
		try {
			await expect(workbench.getByRole("treeitem").first()).toBeVisible({ "timeout": 60_000 });
			await expect(workbench.locator(".tab.active")).toContainText("kept.mjs", { "timeout": 30_000 });
			await expect(workbench.locator(".view-lines").first()).toContainText("const kept = 2;", { "timeout": 20_000 });
		} catch (error) {
			throw new Error(`after ${after}: ${error.message.slice(0, 160)}; tree ${JSON.stringify(await workbench.getByRole("treeitem").allTextContents())}, tabs ${JSON.stringify(await workbench.locator(".tab").allTextContents())}, code ${JSON.stringify(await workbench.locator(".view-lines").allTextContents())}, says ${JSON.stringify(await workbench.locator(".editor-group-container .monaco-editor-pane-placeholder, .editor-placeholder").allTextContents())}`, { "cause": error });
		}
	};

	await openFile(workbench, "kept.mjs");
	await retype(workbench, "const kept = 2;\n");
	await page.waitForTimeout(TABS_KEPT_MS);

	// The page opened again.
	await page.goto(`${await page.url()}&again`);
	await comesBack("opening the page again");

	// And VS Code's own command, which does wait.
	await runCommand(workbench, "Developer: Reload Window");
	await page.waitForTimeout(5000);
	await comesBack("Developer: Reload Window");
});
