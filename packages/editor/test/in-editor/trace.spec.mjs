/**
 * VS Code's own trace for one of its components, as a person turns it on (workbench/editor-state.ts, *Developer: Trace a
 * VS Code Component…*): the component asked for, its messages in the Output channel "VS Code Trace" as they come — what
 * agents' `editor_trace` turns on too. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, runCommand } from "./editor.mjs";

test("a component's trace in the Output as it works: the text file model's, around a save", async ({ page }) => {
	const workbench = await openEditor(page, { "traced.txt": "a\n" });

	await openFile(workbench, "traced.txt");
	// (changed now, saved once the trace is on: the Output, once it opens, is where typing would go)
	await codeOf(workbench).press("End");
	await codeOf(workbench).pressSequentially("b");
	await runCommand(workbench, "Developer: Trace a VS Code Component…");

	const input = workbench.locator(".quick-input-widget input").first();

	await input.fill("text file model");
	await input.press("Enter");

	const output = workbench.locator(".panel .output-view, .panel [id*='output'] .view-lines").first();

	await expect(output).toContainText("Tracing \"text file model\"", { "timeout": 30_000 });

	// (a save: the text file model says what it does)
	await workbench.locator(".editor-group-container .view-lines", { "hasText": "ab" }).first().click();
	await workbench.locator(".editor-group-container .native-edit-context").first().press("ControlOrMeta+s");
	await expect(workbench.locator(".tab.dirty")).toHaveCount(0, { "timeout": 30_000 });
	await expect(output).toContainText("[trace] [text file model]", { "timeout": 30_000 });
});
