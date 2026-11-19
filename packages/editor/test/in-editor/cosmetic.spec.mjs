/**
 * Cosmetic changes, end to end (extensions/cosmetic): the extension activates, reads the changes through the editor's git
 * and their verdicts through its BABLR, and marks a file changed by its formatting or comments only — its hover says so
 * where it's listed — and not one changed for real. The unit test (test/cosmetic.test.mjs) holds the verdicts; this, that
 * a person sees them. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, openFile, openTerminal, READABLE_TERMINAL, retype } from "./editor.mjs";

test("a file changed by a comment alone is marked cosmetic where it's listed; one changed for real isn't", async ({ page }) => {
	const workbench = await openEditor(page, { ...READABLE_TERMINAL, "tidy.ts": "export const a = 1;\n", "real.ts": "export const b = 1;\n" });
	const { input, output } = await openTerminal(workbench);

	await input.pressSequentially("git add -A && git commit -m 'both'\n");
	await expect(output).toContainText("] both", { "timeout": 30_000 });

	await openFile(workbench, "tidy.ts");
	await retype(workbench, "// a comment, and nothing else\nexport const a = 1;\n");
	await openFile(workbench, "real.ts");
	await retype(workbench, "export const b = 2;\n");

	// (its own hover: the one before can still be showing as the pointer moves on)
	const hoverOf = async (name) => {
		// (off the tree first: a hover that's open stays as the pointer moves along the rows)
		await workbench.locator(".editor-instance .view-lines").first().hover();
		await page.waitForTimeout(500);
		await workbench.locator(`[role='treeitem'][aria-level='1'][aria-label='${name}']`).hover();

		return workbench.locator(".monaco-hover:not(.hidden), .workbench-hover", { "hasText": `/${name}` });
	};

	// (read a couple of seconds after the save, in its own time: hovered again until it says so)
	for (let tries = 1; ; tries += 1) {
		const said = await expect(await hoverOf("tidy.ts")).toContainText("Cosmetic", { "timeout": 3000 }).then(() => true, (error) => {
			if (tries === 20) {
				throw error;
			}

			return false;
		});

		if (said) {
			break;
		}
	}

	const real = await hoverOf("real.ts");

	await expect(real).toBeVisible({ "timeout": 15_000 });
	await expect(real).not.toContainText("Cosmetic");
});
