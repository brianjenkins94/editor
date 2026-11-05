/**
 * Run a file (extensions/tsval/run-file.ts), as a person has it: the play button above a code file runs it, as it's written, saved
 * first; none on a file that isn't code; and F5 runs the file you're looking at, wherever the focus is. Runs in the editor:
 * test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, retype, runCommand } from "./editor.mjs";

const files = {
	"program.mjs": "const total = 2 + 3;\n",
	"notes.md": "# Notes\n"
};

test("the Run button runs the file it's on, as it's written; F5 runs the one in sight, wherever the focus is", async ({ page }) => {
	const workbench = await openEditor(page, files);
	const run = workbench.locator(".editor-actions .action-label[aria-label^='Run']");
	const total = workbench.locator(".live-values-row", { "hasText": "total =" });

	// Not on a file that isn't code.
	await openFile(workbench, "notes.md");
	await expect(workbench.locator(".tab.active")).toContainText("notes.md");
	await expect(run).toHaveCount(0);

	// On one that is: it runs, and what it computed shows beside it.
	await openFile(workbench, "program.mjs");
	await run.click();
	await expect(total).toContainText("5", { "timeout": 60_000 });

	// Run as it's written: an edit not yet saved is saved, and it's what runs.
	await codeOf(workbench).press("ControlOrMeta+a");
	await codeOf(workbench).pressSequentially("const total = 3 + 4;\n");
	await expect(workbench.locator(".tab.dirty")).toHaveCount(1);
	await run.click();
	await expect(total).toContainText("7", { "timeout": 60_000 });
	await expect(workbench.locator(".tab.dirty")).toHaveCount(0);

	// F5 with the Output view focused: the file in sight, not the output's channel.
	await retype(workbench, "const total = 4 + 5;\n");
	await runCommand(workbench, "Output: Focus on Output View");
	await workbench.locator(".panel .monaco-editor textarea, .panel .monaco-editor .native-edit-context").first().press("F5");
	await expect(total).toContainText("9", { "timeout": 60_000 });
	await expect(workbench.locator(".repl .monaco-list-row", { "hasText": "Failed to read" })).toHaveCount(0);
});
