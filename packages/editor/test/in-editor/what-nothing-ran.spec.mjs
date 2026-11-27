/**
 * What nothing ran (extensions/history/unrun.ts), as a person asks it: History's “What Nothing Ran…” lists each
 * declaration no test ran — by the tests' reach, `.silo/last-run/reach.json` — as one a run here ran, one other code
 * calls, or one nothing calls, each opening where it is. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, runCommand } from "./editor.mjs";

const files = {
	// (F5's runs only: no live runs)
	".vscode/settings.json": "{ \"run.liveRuns\": false }\n",
	"tsconfig.json": "{ \"compilerOptions\": { \"allowJs\": true, \"checkJs\": false, \"module\": \"esnext\", \"target\": \"esnext\" }, \"include\": [\"**/*\"] }\n",
	"math.mjs": "export function add(a, b) {\n\treturn a + b;\n}\n\nexport function twice(a) {\n\treturn add(a, a);\n}\n\nexport function triple(a) {\n\treturn a * 3;\n}\n\nexport function unused(a) {\n\treturn a - 1;\n}\n",
	"main.mjs": "import { triple, twice } from \"./math.mjs\";\n\nfunction later() {\n\treturn triple(1);\n}\n\nconsole.log(\"twice \" + twice(2));\n",
	// (a test ran add's body, line 2: lines from 0)
	".silo/last-run/reach.json": `${JSON.stringify({ "version": 3, "at": "2026-11-27", "tests": [{ "file": "math.test.mjs", "name": "adds" }], "files": { "math.mjs": { "1": [0] } } })}\n`
};

test("what no test ran, as a run here ran it, as other code calls it, or as nothing does — each opening where it is", async ({ page }) => {
	const workbench = await openEditor(page, files);
	const pick = workbench.locator(".quick-input-widget");
	const row = (text) => pick.locator(".monaco-list-row", { "hasText": text });

	// A run, so what it ran is known.
	await openFile(workbench, "main.mjs");
	await codeOf(workbench).press("F5");
	await expect(workbench.locator(".notes-margin-run.ran")).toHaveCount(1, { "timeout": 60_000 });

	// (asked again until History has read the program, and the run's evidence is kept: it's written as the run ends)
	for (let tries = 1; ; tries += 1) {
		await runCommand(workbench, "History: What Nothing Ran…");

		try {
			await expect(row("Ran in use, no test runs it (1)")).toHaveCount(1, { "timeout": 10_000 });
			break;
		} catch (error) {
			if (tries === 12) {
				throw error;
			}

			await pick.locator("input").first().press("Escape");
		}
	}

	for (const each of [
		"Nothing calls it, nothing ran it (1)",
		"Exported, nothing here names it or ran it (1)",
		"Called, but nothing ran it (1)",
		"Ran in use, no test runs it (1)"
	]) {
		await expect(row(each)).toHaveCount(1, { "timeout": 30_000 });
	}

	for (const [name, where] of [["unused", "math.mjs:13"], ["later", "main.mjs:3"], ["triple", "math.mjs:9"], ["twice", "math.mjs:5"]]) {
		await expect(row(where).filter({ "hasText": name })).toHaveCount(1);
	}

	await expect(row("math.mjs:1 ·")).toHaveCount(0, { "timeout": 1000 });
	await row("math.mjs:13").click();
	await expect(workbench.locator(".tab.active", { "hasText": "math.mjs" })).toBeVisible({ "timeout": 30_000 });
});
