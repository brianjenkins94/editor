/**
 * The evidence diff (extensions/insights/changes.ts), as a person has it: run, commit, edit one file and run again, and
 * Problems says what runs did since the last commit in code that wasn't edited — an arm taken now, a parameter nullish
 * now — from the committed evidence at HEAD against the working tree's (RUNTIME-EVIDENCE.md, *Storage in git*). Runs in
 * the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, openTerminal, problems, retype } from "./editor.mjs";

const files = {
	// (F5's runs only, kept as they end: no live runs; and a terminal to read)
	".vscode/settings.json": "{ \"run.liveRuns\": false, \"terminal.integrated.gpuAcceleration\": \"off\" }\n",
	"world.mjs": "export function greet(name) {\n\tif (name === null) {\n\t\treturn \"nobody\";\n\t}\n\n\treturn \"hello \" + name;\n}\n",
	"main.mjs": "import { greet } from \"./world.mjs\";\n\nconsole.log(greet(\"ann\"));\n"
};

/** The terminal's command, once a run's evidence of world.mjs is written: what a run keeps is written as it ends. */
const whenKept = (then) => `for i in 1 2 3 4 5 6 7 8 9 10; do [ -n "$(find .silo/evidence -name world.mjs.jsonl)" ] && break; sleep 1; done; ${then}\n`;

test("run, commit, change a caller and run again: Problems says what the untouched code did that it hadn't", async ({ page }) => {
	const workbench = await openEditor(page, files);

	await openFile(workbench, "main.mjs");
	await codeOf(workbench).press("F5");
	await expect(workbench.locator(".notes-margin-run.ran")).toHaveCount(1, { "timeout": 60_000 });

	const terminal = await openTerminal(workbench);

	await terminal.input.pressSequentially(whenKept("git add -A && git commit -m first && echo commi''tted"));
	await expect(terminal.output).toContainText("committed", { "timeout": 30_000 });

	await openFile(workbench, "main.mjs");
	await retype(workbench, "import { greet } from \"./world.mjs\";\n\nconsole.log(greet(\"ann\"), greet(null));\n");
	await codeOf(workbench).press("F5");
	await openFile(workbench, "world.mjs");

	const rows = await problems(workbench);

	await expect(rows.filter({ "hasText": "then taken now" })).toHaveCount(1, { "timeout": 60_000 });
	await expect(rows.filter({ "hasText": "nullish now" }).first()).toBeVisible();
	await expect(rows.filter({ "hasText": "since the last commit" }).first()).toBeVisible();
});
