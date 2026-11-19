/**
 * The editor's own log, as a person reads it (extensions/bridge/log-channel.ts, *Developer: Show the Editor's Log*): every
 * context's records in the Output channel "Editor Log" as they come, a span as it ends with its time, under its source —
 * what agents' `logs_query`, `logs_wait` and `spans_query` read from outside. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, openFile, retype, runCommand } from "./editor.mjs";

test("every context's records in the Output as they come, found by its filter: an extension's span and the workbench's", async ({ page }) => {
	const workbench = await openEditor(page, { "logged.mjs": "export const a = 1;\n" });

	await runCommand(workbench, "Developer: Show the Editor's Log");

	const output = workbench.locator(".panel .output-view, .panel [id*='output'] .view-lines").first();

	// (records from then on, at once: the line saying so is soon scrolled past)
	await expect(output).toContainText("[info] [", { "timeout": 30_000 });

	// (a file opened and saved: the notes extension looks at it, the workbench writes it)
	await openFile(workbench, "logged.mjs");
	await retype(workbench, "export const a = 2;\n");
	await runCommand(workbench, "Output: Focus on Output View");

	const filter = workbench.locator(".part.panel .viewpane-filter input").first();

	await filter.fill("notes.look");
	await expect(output).toContainText("[ext:notes] ← editor.extensions.notes.look (", { "timeout": 30_000 });
	await filter.fill("[workbench] ←");
	await expect(output).toContainText("[workbench] ← editor.workbench.", { "timeout": 30_000 });
});
