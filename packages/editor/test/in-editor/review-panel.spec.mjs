/**
 * The review panel (shell/git-panel.tsx), as a person has it: the changed files listed, one picked and committed with a
 * message, another discarded, over the workbench's git (git-service.ts, git-review.ts). Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { changesPanel, gitLog, openEditor, READABLE_TERMINAL } from "./editor.mjs";

test("changes listed, the picked one committed with the message, another discarded", async ({ page }) => {
	const workbench = await openEditor(page, { ...READABLE_TERMINAL, "review-a.txt": "a\n", "review-b.txt": "b\n" });
	const { row, all, allChecked } = await changesPanel(page);

	await expect(row("review-a.txt")).toBeVisible({ "timeout": 60_000 });
	await expect(row("review-b.txt")).toBeVisible();

	// Only review-a.txt picked: everything off (every change is, to begin with), then it on.
	await expect(allChecked).toBeChecked();
	await all.click();
	await expect(allChecked).not.toBeChecked();
	await row("review-a.txt").locator("wa-checkbox").click();
	await page.locator(".gp-commit wa-textarea textarea").fill("from the review panel");
	await page.locator(".gp-commit wa-button").click();

	await expect(row("review-a.txt")).toHaveCount(0, { "timeout": 60_000 });
	await expect(row("review-b.txt")).toBeVisible();
	await expect(await gitLog(workbench)).toContainText("from the review panel", { "timeout": 30_000 });

	// Discard shows on the row that's open (or under the pointer, or focused), and asks once more before it does (the
	// button arms, then fires).
	await row("review-b.txt").locator(".gp-name").click();
	await row("review-b.txt").locator(".gp-discard").click();
	await row("review-b.txt").locator(".gp-discard").click();
	await expect(row("review-b.txt")).toHaveCount(0, { "timeout": 30_000 });
	await expect(workbench.locator("[role='treeitem'][aria-label='review-b.txt']")).toHaveCount(0, { "timeout": 30_000 });
	await expect(workbench.locator("[role='treeitem'][aria-label='review-a.txt']")).toHaveCount(1);
});
