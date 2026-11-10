/**
 * The performance monitor (extensions/insights/monitor.ts, the bridge's metrics-bridge.ts), as a person has it: the status
 * bar says how full the workspace is and the share of time in long frames, and a number's hover has what it did over the
 * last readings. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor } from "./editor.mjs";

test("the status bar says how the editor is doing, and a number's hover has its last readings", async ({ page }) => {
	const workbench = await openEditor(page, { "notes.md": "# Notes\n" });
	const items = workbench.locator(".statusbar-item");
	const workspace = items.filter({ "hasText": /MB \/ \d+ MB/u });

	await expect(workspace).toHaveCount(1, { "timeout": 60_000 });
	await expect(items.filter({ "hasText": /^\s*\d+%\s*$/u })).not.toHaveCount(0);

	await workspace.hover();

	const hover = workbench.locator(".monaco-hover, .workbench-hover", { "hasText": "Workspace file system" });

	await expect(hover).not.toHaveCount(0, { "timeout": 15_000 });
	await expect(hover.first()).toContainText(/the last \d+ readings/u);
});
