/**
 * A reload, as a person does it: the file that was open comes back open, showing its text, not "the file was not found": VS Code
 * restores its tabs as it boots, each read once, and the workspace is mounted after boot, so their reads wait for it (holdFiles). Runs
 * in the editor: test/in-editor.mjs.
 *
 * By VS Code's own command, which keeps which tabs are open first. A frame sent somewhere else (`page.goto`) doesn't wait for that,
 * so on a slow runner it restores no tabs at all.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, retype, runCommand } from "./editor.mjs";

test("the open file comes back as it was saved", async ({ page }) => {
	const workbench = await openEditor(page, { "kept.mjs": "const kept = 1;\n", "other.mjs": "const other = 2;\n" });
	const finding = workbench.locator(".find-widget.visible");

	await openFile(workbench, "kept.mjs");
	await retype(workbench, "const kept = 2;\n");

	// (the find widget's open, which a reload doesn't bring back: gone, it's the page after it)
	await codeOf(workbench).press("ControlOrMeta+f");
	await expect(finding).toHaveCount(1, { "timeout": 15_000 });

	await runCommand(workbench, "Developer: Reload Window");
	await expect(finding).toHaveCount(0, { "timeout": 60_000 });

	try {
		await expect(workbench.locator(".tab.active")).toContainText("kept.mjs", { "timeout": 40_000 });
		await expect(workbench.locator(".view-lines").first()).toContainText("const kept = 2;", { "timeout": 20_000 });
	} catch (error) {
		throw new Error(`${error.message.slice(0, 160)}; tree ${JSON.stringify(await workbench.getByRole("treeitem").allTextContents())}, tabs ${JSON.stringify(await workbench.locator(".tab").allTextContents())}, code ${JSON.stringify(await workbench.locator(".view-lines").allTextContents())}`, { "cause": error });
	}
});
