/**
 * Which files BABLR parses (workbench/bablr.ts), as a person finds out: the command, what it says, and the warning in
 * Problems, gone once the file's fixed. Runs in the editor: test/in-editor.mjs.
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

	// Fixed in the editor and saved, it parses: its warning goes.
	await workbench.locator(".markers-panel").getByText(/BABLR can't parse this file/u).dblclick();

	const code = workbench.locator(".editor-instance .native-edit-context").first();

	await code.pressSequentially("// ");
	await expect(workbench.locator(".editor-instance .view-lines")).toHaveText("// export const = ;");
	await code.press("ControlOrMeta+s");
	await expect(workbench.locator(".tab.dirty")).toHaveCount(0, { "timeout": 30_000 });
	await expect(workbench.locator(".markers-panel").getByText(/BABLR can't parse this file/u)).toHaveCount(0, { "timeout": 60_000 });
});
