/**
 * Your edits since the last commit (workbench/edit-history.ts, the BABLR worker's editGroups, shell/git-panel.tsx), as a
 * person has them: a file's bursts of typing are kept, and under its row in the changes panel, Your edits shows the code
 * each touched, the same after a reload. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile } from "./editor.mjs";

/** The changes panel's Your edits for `file`, opened: its chunks. */
async function yourEdits(page, file) {
	const panel = page.locator(".gp");

	if (!await panel.isVisible()) {
		await page.locator("wa-button[aria-label='Toggle changes panel']").click();
	}

	await page.locator(".gp-file", { "hasText": file }).locator("wa-button[aria-label='Your edits']").click();

	return page.locator(".gp-chunks");
}

test("a file's bursts of typing are kept, and Your edits shows the code each touched, after a reload too", async ({ page }) => {
	await openEditor(page, { "program.ts": "const start = 1;\n" });

	const workbench = page.frameLocator("iframe[title='editor']").frameLocator("iframe");

	await openFile(workbench, "program.ts");

	// Two bursts, a pause between them (a burst ends when the typing does), then saved.
	await codeOf(workbench).press("ControlOrMeta+End");
	await codeOf(workbench).pressSequentially("const total = start + 1;\n");
	await page.waitForTimeout(1500);
	await codeOf(workbench).pressSequentially("const doubled = total * 2;\n");
	await codeOf(workbench).press("ControlOrMeta+s");
	await expect(workbench.locator(".tab.dirty")).toHaveCount(0, { "timeout": 30_000 });

	const chunks = await yourEdits(page, "program.ts");

	await expect(chunks).toContainText("total", { "timeout": 60_000 });
	await expect(chunks).toContainText("doubled");
	await expect(chunks).toContainText(/\d+ edits/u);

	// Kept: the same after a reload (its own address again, without the files it was seeded with).
	const again = new URL(await page.url());

	again.searchParams.delete("seed");
	await page.goto(again.href);
	await expect(workbench.getByRole("treeitem").first()).toBeVisible({ "timeout": 120_000 });
	await expect(await yourEdits(page, "program.ts")).toContainText("doubled", { "timeout": 60_000 });
});
