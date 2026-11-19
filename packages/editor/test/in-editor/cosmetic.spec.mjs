/**
 * Cosmetic changes, end to end (extensions/cosmetic): the extension activates, reads the changes through the editor's git
 * and their verdicts through its BABLR, and marks a file changed by its formatting or comments only — its hover says so
 * where it's listed — and not one changed for real. The unit test (test/cosmetic.test.mjs) holds the verdicts; this, that
 * a person sees them. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { hoverUntil, openEditor, openFile, openTerminal, READABLE_TERMINAL, retype } from "./editor.mjs";

test("a file changed by a comment alone is marked cosmetic where it's listed; one changed for real isn't", async ({ page }) => {
	const workbench = await openEditor(page, { ...READABLE_TERMINAL, "tidy.ts": "export const a = 1;\n", "real.ts": "export const b = 1;\n" });
	const { input, output } = await openTerminal(workbench);

	await input.pressSequentially("git add -A && git commit -m 'both'\n");
	await expect(output).toContainText("] both", { "timeout": 30_000 });

	await openFile(workbench, "tidy.ts");
	await retype(workbench, "// a comment, and nothing else\nexport const a = 1;\n");
	await openFile(workbench, "real.ts");
	await retype(workbench, "export const b = 2;\n");

	// (off the tree between hovers: a hover that's open stays as the pointer moves along the rows)
	const code = workbench.locator(".editor-instance .view-lines").first();
	const row = (name) => workbench.locator(`[role='treeitem'][aria-level='1'][aria-label='${name}']`);
	// (its own hover: the one before can still be showing as the pointer moves on)
	const hoverOf = (name) => workbench.locator(".monaco-hover:not(.hidden), .workbench-hover", { "hasText": `/${name}` });

	// (read a couple of seconds after the save, in its own time: hovered again until it says so)
	await hoverUntil(page, { "target": row("tidy.ts"), "shown": hoverOf("tidy.ts").filter({ "hasText": "Cosmetic" }), "away": code, "tries": 20 });
	await hoverUntil(page, { "target": row("real.ts"), "shown": hoverOf("real.ts"), "away": code });
	await expect(hoverOf("real.ts")).not.toContainText("Cosmetic");
});
