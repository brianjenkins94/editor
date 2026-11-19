/**
 * What's been decided about a file, as a person asks it (workbench/decisions.ts, *History: What's Been Decided About This
 * File…*): the file in front, the ledger's entries holding it and the docs' lines naming it, shown read-only beside it —
 * what agents' `decisions_for` asks too. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, openFile, runCommand } from "./editor.mjs";

const LEDGER = {
	"Loading": {
		"status": "active",
		"why": "the core loads",
		"since": "2026-11-02",
		"paths": ["a.ts"]
	}
};

test("what's been decided about the file in front: its feature in the ledger, the docs' lines naming it, beside it", async ({ page }) => {
	const workbench = await openEditor(page, {
		"a.ts": "export const a = 1;\n",
		".silo/features.json": JSON.stringify(LEDGER, null, "\t") + "\n",
		"NEXT.md": "# Next\n\n## Queue\n\n- a.ts loads the repository first.\n"
	});

	await openFile(workbench, "a.ts");
	await runCommand(workbench, "History: What's Been Decided About This File…");

	// (the file in front, offered: taken as it is)
	const input = workbench.locator(".quick-input-widget input").first();

	await expect(input).toHaveValue("a.ts", { "timeout": 15_000 });
	await input.press("Enter");

	const shown = workbench.locator(".editor-instance .view-lines").last();

	await expect(workbench.locator(".tab.active", { "hasText": "a.ts.md" })).toBeVisible({ "timeout": 60_000 });
	await expect(shown).toContainText("Loading", { "timeout": 30_000 });
	await expect(shown).toContainText("NEXT.md:5");
});
