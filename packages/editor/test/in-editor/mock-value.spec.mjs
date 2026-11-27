/**
 * Mock a value and a rule placed in the code, as a person has them: from the lightbulb on the line, a variable set on every run,
 * by a rule marked in the gutter that follows its code and says so when it's lost; and the program's arguments. Runs in the
 * editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, problems, quickFix, retype, runCommand } from "./editor.mjs";

const PROGRAM = `const rate = 2;
const total = rate * 10;
console.log("total " + total);
`;

async function answer(workbench, text) {
	const input = workbench.locator(".quick-input-widget input").first();

	await input.fill(text);
	await input.press("Enter");
}

const said = (workbench, text) => workbench.locator(".repl .output", { "hasText": text }).first();

test("a variable set on every run: the rule sets it, const or not, shows in the gutter, follows its code, says so when it's lost, and is put back", async ({ page }) => {
	// (F5's runs only: a live run a save starts could be the one F5 finds, from before the rule was put back)
	const workbench = await openEditor(page, { ".vscode/settings.json": "{ \"run.liveRuns\": false }\n", "rate.mjs": PROGRAM });

	await openFile(workbench, "rate.mjs");
	await quickFix(workbench, "Set rate on every run");
	await answer(workbench, "5");

	const mark = workbench.locator(".notes-margin-mark[title*='rate']");

	await expect(mark).toHaveCount(1, { "timeout": 60_000 });

	await codeOf(workbench).press("F5");
	await expect(workbench.locator(".notes-margin-cell", { "hasText": "total =" })).toContainText("50", { "timeout": 60_000 });
	// (opened, not found open: VS Code opens it on a window's first debug session only, and this editor may have had one)
	await runCommand(workbench, "Debug Console: Focus on Debug Console View");
	await expect(said(workbench, "total 50")).toBeVisible({ "timeout": 30_000 });

	// It follows its code.
	await retype(workbench, `// a line above it\n${PROGRAM.replace("* 10", "* 100")}`);
	await expect(mark).toHaveCount(1, { "timeout": 60_000 });
	await codeOf(workbench).press("F5");
	await expect(said(workbench, "total 500")).toBeVisible({ "timeout": 60_000 });

	// Its code gone, it doesn't apply, and it says so.
	await retype(workbench, "console.log(\"nothing to set\");\n");

	const rows = await problems(workbench);

	await expect(rows.filter({ "hasText": "A rule's place in this file is lost" })).toHaveCount(1, { "timeout": 60_000 });

	// Put back where it belongs, from the lightbulb on that line, it applies again.
	await openFile(workbench, "rate.mjs");
	await retype(workbench, PROGRAM.replace("= 2", "= 3"));

	// (to its first line, however many lines typing it made: a newline typed under load can make one more)
	await codeOf(workbench).press("PageUp");
	await codeOf(workbench).press("PageUp");
	await codeOf(workbench).press("Home");
	await quickFix(workbench, "Put the rule back here");
	// (its mark the one that applies, not one it isn't sure of)
	await expect(workbench.locator(".notes-margin-mark[title*='rate']:not([title^='Not sure'])")).toHaveCount(1, { "timeout": 60_000 });
	await expect(rows.filter({ "hasText": "A rule's place in this file is lost" })).toHaveCount(0, { "timeout": 60_000 });
	await codeOf(workbench).press("F5");
	await runCommand(workbench, "Debug Console: Focus on Debug Console View");
	await expect(workbench.locator(".repl .output", { "hasText": /total \d+/u }).last()).toContainText("total 50", { "timeout": 60_000 });
});

test("the program's arguments on every run, from the lightbulb on process.argv", async ({ page }) => {
	const workbench = await openEditor(page, { "args.mjs": "console.log(\"args \" + process.argv.slice(2).join(\"+\"));\n" });

	await openFile(workbench, "args.mjs");
	await quickFix(workbench, "Give the program its arguments");
	await answer(workbench, "--port \"8 0\"");

	await expect(workbench.getByRole("treeitem", { "name": ".silo", "exact": true })).toBeVisible({ "timeout": 30_000 });
	await codeOf(workbench).press("F5");
	// (opened, not found open: VS Code opens it on a window's first debug session only, and this editor may have had one)
	await runCommand(workbench, "Debug Console: Focus on Debug Console View");
	await expect(said(workbench, "args --port+8 0")).toBeVisible({ "timeout": 60_000 });
});

test("a variable set now, at a stop, is what the run goes on with; a const can't be", async ({ page }) => {
	const workbench = await openEditor(page, { "now.mjs": `import { writeFileSync } from "node:fs";

let count = 1;
writeFileSync("/workspace/kept.txt", "kept");
console.log("count " + count);
` });

	await openFile(workbench, "now.mjs");
	await codeOf(workbench).press("F5");

	const allow = workbench.locator(".notes-margin-cell .live-values-choice", { "hasText": "Allow" }).first();

	await expect(allow).toBeVisible({ "timeout": 60_000 });
	await codeOf(workbench).press("ArrowUp");
	await expect(workbench.locator(".statusbar-item", { "hasText": "Ln 3" })).toBeVisible({ "timeout": 30_000 });
	await quickFix(workbench, "Set count now");
	await answer(workbench, "7");
	await expect(workbench.locator(".notes-margin-cell", { "hasText": "count =" })).toContainText("7", { "timeout": 30_000 });

	await allow.click();
	// (opened, not found open: VS Code opens it on a window's first debug session only, and this editor may have had one)
	await runCommand(workbench, "Debug Console: Focus on Debug Console View");
	await expect(said(workbench, "count 7")).toBeVisible({ "timeout": 60_000 });
});
