/**
 * Spell check (extensions/cspell): a word it doesn't know is dotted under as it's typed, and says so on hover; it isn't in
 * Problems, and put right, its dots go. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, hoverUntil, openEditor, openFile, problems, retype } from "./editor.mjs";

test("a misspelt word is dotted under and says so on hover, isn't in Problems, and is let be once it's right", async ({ page }) => {
	const workbench = await openEditor(page, { "notes.ts": "// misspeltt\nexport const right = 1;\n" });

	await openFile(workbench, "notes.ts");

	const dots = workbench.locator(".editor-instance .squiggly-hint");

	// (the first waits out cspell's worker and its dictionaries)
	await expect(dots.first()).toBeVisible({ "timeout": 120_000 });
	await expect(dots).toHaveCount(1);
	await hoverUntil(page, { "target": workbench.locator(".editor-instance .view-line span span", { "hasText": "misspeltt" }).first(), "shown": workbench.locator(".monaco-hover", { "hasText": "misspeltt" }).first(), "away": workbench.locator(".part.statusbar").first() });

	const rows = await problems(workbench);

	await expect(rows.filter({ "hasText": "misspeltt" })).toHaveCount(0);

	await codeOf(workbench).focus();
	await retype(workbench, "// misspelt\nexport const right = 1;\n");
	await expect(dots).toHaveCount(0, { "timeout": 60_000 });
});
