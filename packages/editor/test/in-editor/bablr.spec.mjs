/**
 * Which files BABLR parses (workbench/bablr.ts), as a person finds out: the command, what it says, and the warning in
 * Problems. Runs in the editor: test/in-editor.mjs. A file's warning going once it's fixed waits on typing in a test (NEXT.md),
 * and is still test/bablr.mjs's, with the parses kept and the agents' request.
 */
import { expect, test } from "@playwright/test";

import { openEditor, runCommand } from "./editor.mjs";

test("a folder checked says what BABLR parses, with a file it can't a warning in Problems", async ({ page }) => {
	const workbench = await openEditor(page, {
		"parses/fine.ts": "export const fine = 1;\n",
		"parses/broken.ts": "export const = ;\n"
	});

	await runCommand(workbench, "BABLR: Check Which Files Parse");
	await workbench.locator(".quick-input-widget input").first().fill("parses");
	await workbench.locator(".quick-input-widget input").first().press("Enter");

	// (the first waits out BABLR's worker loading)
	const toast = workbench.locator(".notification-toast");

	await expect(toast.getByText(/BABLR parses 1 of 2 files in parses/u)).toBeVisible({ "timeout": 300_000 });
	await toast.getByRole("button", { "name": "Show Problems" }).click();
	await expect(workbench.locator(".markers-panel").getByText(/BABLR can't parse this file/u)).toBeVisible({ "timeout": 30_000 });
	await expect(workbench.locator(".markers-panel").getByText("broken.ts")).toBeVisible();
});
