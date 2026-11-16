/**
 * Source Control (extensions/source-control/), VS Code's view of the workspace's git, as a person has it: a change listed,
 * committed from its input box. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { gitLog, openEditor, READABLE_TERMINAL, runCommand } from "./editor.mjs";

test("a change listed, committed from its input box", async ({ page }) => {
	const workbench = await openEditor(page, { ...READABLE_TERMINAL, "scm-a.txt": "scm\n" });

	await runCommand(workbench, "Source Control: Focus on Changes View");

	const listed = workbench.locator(".scm-view .monaco-list-row", { "hasText": "scm-a.txt" });

	await expect(listed.first()).toBeVisible({ "timeout": 60_000 });
	await workbench.locator(".scm-editor .monaco-editor").first().click();
	await workbench.locator(".scm-editor .native-edit-context").first().pressSequentially("from Source Control");
	await expect(workbench.locator(".scm-editor .view-lines").first()).toHaveText("from Source Control");
	await workbench.locator(".scm-editor .native-edit-context").first().press("ControlOrMeta+Enter");

	await expect(listed).toHaveCount(0, { "timeout": 60_000 });
	await expect(await gitLog(workbench)).toContainText("from Source Control", { "timeout": 30_000 });
});
