/**
 * The messages between the editor's contexts, as a person reads them (extensions/bridge/message-channel.ts, *Developer:
 * Show the Editor's Messages*): each one sampled, from and to, what it was, and what it carried — payload capture on
 * while it shows, as agents' `payloads_capture` turns it on. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, runCommand } from "./editor.mjs";

test("the messages between the editor's contexts in the Output as they come, with what each carried", async ({ page }) => {
	const workbench = await openEditor(page, { "notes.md": "# Notes\n" });

	await runCommand(workbench, "Developer: Show the Editor's Messages");

	const output = workbench.locator(".panel .output-view, .panel [id*='output'] .view-lines").first();

	// (from then on, at once: the line saying so is soon scrolled past) — and what one carried: a metrics sample's
	// values, sent every second by each context, captured only while this shows
	await expect(output).toContainText(" → ", { "timeout": 30_000 });
	await expect(output).toContainText("{\"source\":\"", { "timeout": 30_000 });
});
