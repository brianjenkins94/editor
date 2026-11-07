/**
 * Experiments that undo themselves, as a person has them: Save Checkpoint, try a change, and Restore Checkpoint… puts the files
 * back as they were. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, openFile, retype, runCommand } from "./editor.mjs";

// (no runs here: what's tried is an edit)
const files = { ".vscode/settings.json": "{ \"run.liveRuns\": false }\n", "kept.mjs": "export const kept = 1;\n" };

async function answer(workbench, text) {
	const input = workbench.locator(".quick-input-widget input").first();

	await input.fill(text);
	await input.press("Enter");
}

test("a checkpoint saved, a change tried, and every file put back as it was", async ({ page }) => {
	const workbench = await openEditor(page, files);
	const code = workbench.locator(".editor-instance .view-lines").first();

	await openFile(workbench, "kept.mjs");
	await runCommand(workbench, "Workspace: Save Checkpoint");
	await answer(workbench, "before the change");
	await expect(workbench.locator(".notification-list-item-message", { "hasText": "Checkpoint saved: before the change" }).first()).toBeVisible({ "timeout": 30_000 });

	await retype(workbench, "export const kept = 2;\nexport const tried = true;\n");
	await expect(code).toContainText("tried", { "timeout": 30_000 });

	await runCommand(workbench, "Workspace: Restore Checkpoint…");
	await expect(workbench.locator(".quick-input-list .monaco-list-row", { "hasText": "before the change" }).first()).toBeVisible({ "timeout": 15_000 });
	await workbench.locator(".quick-input-widget input").first().press("Enter");

	await expect(code).not.toContainText("tried", { "timeout": 60_000 });
	await expect(code).toContainText("kept = 1", { "timeout": 30_000 });
	await expect(workbench.locator(".notification-list-item-message", { "hasText": "Restored 1 file" }).first()).toBeVisible({ "timeout": 30_000 });
	await expect(workbench.locator(".tab.dirty")).toHaveCount(0);
});
