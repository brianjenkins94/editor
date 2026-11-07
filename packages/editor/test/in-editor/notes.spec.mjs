/**
 * Notes on code, as a person has them: beside the code in the Margin, following it through edits; when its code goes, waiting in
 * Problems to be put back or dismissed. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, problems, quickFix, retype, runCommand } from "./editor.mjs";

// (no runs here: what's beside the code is the note)
const files = { ".vscode/settings.json": "{ \"run.liveRuns\": false }\n", "noted.mjs": "const rate = 2;\nconst total = rate * 10;\n" };

async function answer(workbench, text) {
	const input = workbench.locator(".quick-input-widget input").first();

	await input.fill(text);
	await input.press("Enter");
}

/** The cursor to the file's start, on any platform. */
async function top(workbench) {
	await codeOf(workbench).press("ControlOrMeta+a");
	await codeOf(workbench).press("ArrowLeft");
}

test("a note is beside its code, follows it, and when its code goes waits in Problems to be put back", async ({ page }) => {
	const workbench = await openEditor(page, files);
	const note = workbench.locator(".pane-item.tone-info", { "hasText": "two for now" });

	await openFile(workbench, "noted.mjs");
	await runCommand(workbench, "Notes: Add Note");
	await answer(workbench, "two for now");
	await expect(note).toBeVisible({ "timeout": 60_000 });
	await expect(workbench.getByRole("treeitem", { "name": ".silo", "exact": true })).toBeVisible({ "timeout": 30_000 });

	// It follows its code: lines above it, and its lightbulb's on the line it moved to.
	await retype(workbench, "// a line above\n// and another\nconst rate = 2;\nconst total = rate * 10;\n");
	await expect(note).toBeVisible({ "timeout": 60_000 });
	await top(workbench);
	await codeOf(workbench).press("ArrowDown");
	await codeOf(workbench).press("ArrowDown");
	await expect(workbench.locator(".statusbar-item", { "hasText": "Ln 3" })).toBeVisible({ "timeout": 30_000 });
	await quickFix(workbench, "Dismiss note: two for now");
	await expect(note).toHaveCount(0, { "timeout": 60_000 });

	// Another, and its code goes: not beside anything, and in Problems.
	await runCommand(workbench, "Notes: Add Note");
	await answer(workbench, "ten of them");
	await expect(workbench.locator(".pane-item.tone-info", { "hasText": "ten of them" })).toBeVisible({ "timeout": 60_000 });
	await retype(workbench, "console.log(\"something else\");\nconsole.log(\"entirely\");\n");

	const rows = await problems(workbench);

	await expect(rows.filter({ "hasText": "A note lost its place" })).toHaveCount(1, { "timeout": 60_000 });
	await expect(workbench.locator(".pane-item.tone-info", { "hasText": "ten of them" })).toHaveCount(0);

	// Put back where the cursor is.
	await runCommand(workbench, "View: Focus Active Editor Group");
	await top(workbench);
	await quickFix(workbench, "Put the note back here: ten of them");
	await expect(workbench.locator(".pane-item.tone-info", { "hasText": "ten of them" })).toBeVisible({ "timeout": 60_000 });
	await expect(rows.filter({ "hasText": "A note lost its place" })).toHaveCount(0, { "timeout": 60_000 });
});
