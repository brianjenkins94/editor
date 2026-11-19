/**
 * The blame of a file, as a person reads it (workbench/git-history.ts, *Git: Show Blame for This File*): each line beside
 * the commit that last changed it, a line not committed yet as `working` — what agents' `git_blame` asks too. Runs in the
 * editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, openTerminal, READABLE_TERMINAL, runCommand } from "./editor.mjs";

test("each line beside the commit that last changed it, and a change not committed yet as working", async ({ page }) => {
	const workbench = await openEditor(page, { ...READABLE_TERMINAL, "kept.ts": "export const changed = 1;\nexport const kept = 1;\n" });
	const { input, output } = await openTerminal(workbench);

	await input.pressSequentially("git add -A && git commit -m 'kept and changed'\n");
	await expect(output).toContainText("] kept and changed", { "timeout": 30_000 });

	await openFile(workbench, "kept.ts");
	// (the first line changed, where a file opens, and saved)
	await codeOf(workbench).press("End");
	await codeOf(workbench).press("Backspace");
	await codeOf(workbench).press("Backspace");
	await codeOf(workbench).pressSequentially("2;");
	await codeOf(workbench).press("ControlOrMeta+s");
	await expect(workbench.locator(".tab.dirty")).toHaveCount(0, { "timeout": 30_000 });

	await runCommand(workbench, "Git: Show Blame for This File");

	const blame = workbench.locator(".editor-instance .view-lines").last();
	const today = new Date().toISOString().slice(0, 10);

	await expect(blame).toContainText(`${today}`, { "timeout": 60_000 });
	await expect(blame).toContainText("export const kept = 1;");
	await expect(blame).toContainText("working");
	await expect(blame).toContainText("export const changed = 2;");
});
