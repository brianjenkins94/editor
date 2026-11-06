/**
 * Mock a value and a rule placed in the code, as a person has them: from the lightbulb on the line, a variable set on every run,
 * by a rule marked in the gutter that follows its code and says so when it's lost; and the program's arguments. Runs in the
 * editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, problems, retype, runCommand } from "./editor.mjs";

const PROGRAM = `const rate = 2;
const total = rate * 10;
console.log("total " + total);
`;

/** Quick Fix where the cursor is, and one of its actions. */
async function fix(workbench, title) {
	const row = workbench.locator(".action-widget .monaco-list-row", { "hasText": title });

	await expect(codeOf(workbench)).toBeFocused({ "timeout": 30_000 });

	// (nothing says the Margin's up yet, and it isn't until a file like this has been open a moment: ask again, as a person would)
	for (let tries = 0; ; tries += 1) {
		await runCommand(workbench, "Quick Fix...");

		try {
			await expect(row).toBeVisible({ "timeout": 5000 });
			break;
		} catch (error) {
			if (tries === 12) {
				throw error;
			}

			await codeOf(workbench).press("Escape");
		}
	}

	await row.click();
}

async function answer(workbench, text) {
	const input = workbench.locator(".quick-input-widget input").first();

	await input.fill(text);
	await input.press("Enter");
}

const said = (workbench, text) => workbench.locator(".repl .output", { "hasText": text }).first();

test("a variable set on every run: the rule sets it, const or not, shows in the gutter, follows its code, and says so when it's lost", async ({ page }) => {
	const workbench = await openEditor(page, { "rate.mjs": PROGRAM });

	await openFile(workbench, "rate.mjs");
	await fix(workbench, "Set rate on every run");
	await answer(workbench, "5");

	const mark = workbench.locator(".notes-margin-mark[title*='rate']");

	await expect(mark).toHaveCount(1, { "timeout": 60_000 });

	await codeOf(workbench).press("F5");
	await expect(workbench.locator(".notes-margin-cell", { "hasText": "total =" })).toContainText("50", { "timeout": 60_000 });
	await workbench.locator(".panel .action-label", { "hasText": "Debug Console" }).first().click();
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
});

test("the program's arguments on every run, from the lightbulb on process.argv", async ({ page }) => {
	const workbench = await openEditor(page, { "args.mjs": "console.log(\"args \" + process.argv.slice(2).join(\"+\"));\n" });

	await openFile(workbench, "args.mjs");
	await fix(workbench, "Give the program its arguments");
	await answer(workbench, "--port \"8 0\"");

	await expect(workbench.getByRole("treeitem", { "name": ".silo", "exact": true })).toBeVisible({ "timeout": 30_000 });
	await codeOf(workbench).press("F5");
	await workbench.locator(".panel .action-label", { "hasText": "Debug Console" }).first().click();
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
	await fix(workbench, "Set count now");
	await answer(workbench, "7");
	await expect(workbench.locator(".notes-margin-cell", { "hasText": "count =" })).toContainText("7", { "timeout": 30_000 });

	await allow.click();
	await workbench.locator(".panel .action-label", { "hasText": "Debug Console" }).first().click();
	await expect(said(workbench, "count 7")).toBeVisible({ "timeout": 60_000 });
});
