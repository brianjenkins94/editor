/**
 * What went through this code, on hover (extensions/insights/hover.ts), as a person has it: run a file, then hover the
 * code, and the runs kept in git say what went through it. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, runCommand } from "./editor.mjs";

const files = {
	// (one run, F5's: no live runs, which aren't kept)
	".vscode/settings.json": "{ \"run.liveRuns\": false }\n",
	"played.mjs": "function play(world, score) {\n\tworld.onWin?.();\n\n\treturn score > 10 ? \"won\" : \"lost\";\n}\n\nconst world = { \"onWin\": () => undefined };\n\nconsole.log(play(world, 12), play(world, 3));\n"
};

/** The hover at the cursor, on `line` (1-based) `right` characters in, asked until it says `text`: what a run keeps is
 *  written as it ends. */
async function hoverSays(workbench, line, right, text) {
	const code = codeOf(workbench);
	const hover = workbench.locator(".monaco-hover:not(.hidden)", { "hasText": text });

	await code.press("ControlOrMeta+a");
	await code.press("ArrowLeft");

	for (let at = 1; at < line; at += 1) {
		await code.press("ArrowDown");
	}

	for (let at = 0; at < right; at += 1) {
		await code.press("ArrowRight");
	}

	for (let tries = 0; ; tries += 1) {
		await runCommand(workbench, "Show or Focus Hover");

		try {
			await expect(hover.first()).toBeVisible({ "timeout": 5000 });

			return hover.first();
		} catch (error) {
			if (tries === 12) {
				throw error;
			}

			await code.press("Escape");
		}
	}
}

test("a run, then the hover: what went through a ?. and which way a ?: went", async ({ page }) => {
	const workbench = await openEditor(page, files);

	await openFile(workbench, "played.mjs");
	await codeOf(workbench).press("F5");
	await expect(workbench.locator(".notes-margin-run.ran")).toHaveCount(1, { "timeout": 60_000 });

	const tested = await hoverSays(workbench, 2, 2, "never nullish");

	await expect(tested).toContainText("2 values in 1 run");
	await expect(tested).toContainText("function");
	await codeOf(workbench).press("Escape");

	const branch = await hoverSays(workbench, 4, 9, "50%");

	await expect(branch).toContainText("in 1 run");
});
