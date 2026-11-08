/**
 * What could go, in purple (extensions/insights/fixes.ts), as a person has it: run a file, and a `?.` the runs never needed
 * is marked, with its removal in the lightbulb. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, quickFix } from "./editor.mjs";

const files = {
	// (one run, F5's, says enough here: no live runs, which aren't kept)
	".vscode/settings.json": "{ \"run.liveRuns\": false, \"silo.evidence.minRuns\": 1, \"silo.evidence.minSeen\": 1 }\n",
	"played.mjs": "function play(world) {\n\treturn world.onWin?.();\n}\n\nplay({ \"onWin\": () => \"won\" });\n"
};

test("a run, then the purple: a ?. never needed, and the lightbulb takes it out", async ({ page }) => {
	const workbench = await openEditor(page, files);
	const code = codeOf(workbench);

	await openFile(workbench, "played.mjs");
	await code.press("F5");
	await expect(workbench.locator(".notes-margin-run.ran")).toHaveCount(1, { "timeout": 60_000 });

	// On the ?. line.
	await code.press("ControlOrMeta+a");
	await code.press("ArrowLeft");
	await code.press("ArrowDown");
	await code.press("Home");

	// (onto the ?. of `return world.onWin?.();`)
	for (let at = 0; at < "return world.onWin?".length; at += 1) {
		await code.press("ArrowRight");
	}
	await quickFix(workbench, "Remove the `?.`");
	await expect(workbench.locator(".view-line", { "hasText": "return world.onWin();" })).toBeVisible({ "timeout": 30_000 });
});
