/**
 * Live runs, as a person has them: the file you're editing runs again on its own, on a save or on an interval, and the Margin
 * stays current. Nobody's watching, so nothing happens to the world and nothing asks, and a call it can't make can be pinned or
 * given a rule from its line. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, retype } from "./editor.mjs";

const cell = (workbench, text) => workbench.locator(".notes-margin-cell", { "hasText": text });
const action = (workbench, title) => workbench.locator(".live-values-choice", { "hasText": title }).first();
/** The row of the open picker saying `text`, by the keyboard: `down` rows down from the first. */
async function pickRow(workbench, text, down = 0) {
	const input = workbench.locator(".quick-input-widget input").first();

	await expect(workbench.locator(".quick-input-list .monaco-list-row", { "hasText": text }).first()).toBeVisible({ "timeout": 15_000 });

	for (let times = 0; times < down; times += 1) {
		await input.press("ArrowDown");
	}

	await input.press("Enter");
}

test("an edit runs on its own: the Margin keeps up, nothing happens to the world, and text that doesn't parse leaves the last run's", async ({ page }) => {
	const workbench = await openEditor(page, { "live.mjs": "const total = 1 + 1;\n" });

	await openFile(workbench, "live.mjs");
	await retype(workbench, `import { readFileSync, writeFileSync } from "node:fs";
const total = 3 * 10;
writeFileSync("/workspace/out.txt", "written " + total);
const back = readFileSync("/workspace/out.txt", "utf8");
`);
	// On its own, reading back what it wrote: in its own layer, as the file isn't there.
	await expect(cell(workbench, "total =")).toContainText("30", { "timeout": 60_000 });
	await expect(cell(workbench, "back =")).toContainText("written 30", { "timeout": 30_000 });
	await expect(workbench.getByRole("treeitem", { "name": "out.txt" })).toHaveCount(0);
	// Quiet: no toolbar, nothing asked.
	await expect(workbench.locator(".debug-toolbar")).toHaveCount(0);

	// A statement half written: the last run's stay.
	await retype(workbench, "const total = 3 * 10;\nconst more = (\n");
	await page.waitForTimeout(6000);
	await expect(cell(workbench, "total =")).toContainText("30");

	// Written out again, it's current again.
	await retype(workbench, "const total = 4 * 10;\n");
	await expect(cell(workbench, "total =")).toContainText("40", { "timeout": 60_000 });
});

test("a save runs it, off the interval; too long a run stops where it got to, saying so", async ({ page }) => {
	const workbench = await openEditor(page, { ".vscode/settings.json": "{ \"run.liveRuns.interval\": 0 }\n", "saved.mjs": "const total = 1 + 1;\n" });

	await openFile(workbench, "saved.mjs");
	// Typed and not saved: nothing runs.
	await codeOf(workbench).press("ControlOrMeta+a");
	await codeOf(workbench).pressSequentially("const total = 2 * 10;\n");
	await page.waitForTimeout(6000);
	await expect(cell(workbench, "total =")).toHaveCount(0);

	await codeOf(workbench).press("ControlOrMeta+s");
	await expect(cell(workbench, "total =")).toContainText("20", { "timeout": 60_000 });

	await retype(workbench, "let turns = 0;\nwhile (true) {\n\tturns += 1;\n}\n");
	await expect(workbench.locator(".notes-margin-mark.run-stopped")).toHaveAttribute("title", /too long to run live/u, { "timeout": 60_000 });

	// Waiting on what nothing will settle, it ends there all the same, with what it did.
	await retype(workbench, "const before = 1;\nawait new Promise(() => {});\nconst after = 2;\n");
	await expect(cell(workbench, "before =")).toContainText("1", { "timeout": 60_000 });
	await expect(cell(workbench, "after =")).toHaveCount(0);
});

test("F5 just after a save starts your run, with a live one going, and opens the Debug Console", async ({ page }) => {
	const workbench = await openEditor(page, { "mine.mjs": "const nothing = 0;\n" });

	await openFile(workbench, "mine.mjs");
	// (long enough to still be going: a live run's what's in front of it)
	await retype(workbench, "let turns = 0;\nfor (let at = 0; at < 2000000; at += 1) {\n\tturns += 1;\n}\nconsole.log(\"mine \" + turns);\n");
	await page.waitForTimeout(600);
	await codeOf(workbench).press("F5");
	await expect(workbench.locator(".repl .output", { "hasText": "mine 2000000" }).first()).toBeVisible({ "timeout": 120_000 });
});

test("a call it can't make says so on its line, and a rule gives it a value for runs after an edit alone", async ({ page }) => {
	const workbench = await openEditor(page, { "calls.mjs": "const nothing = 0;\n" });

	await openFile(workbench, "calls.mjs");
	await retype(workbench, `import { execSync } from "node:child_process";
const listed = execSync("ls");
const total = 1 + 1;
`);
	// Skipped, the run going on, and not stopped to ask.
	await expect(cell(workbench, "total =")).toContainText("2", { "timeout": 60_000 });
	await expect(action(workbench, "Pin…")).toBeVisible({ "timeout": 30_000 });

	// Rule…: this call, given a value.
	await action(workbench, "Rule…").click();
	await pickRow(workbench, "Just ls");
	await pickRow(workbench, "Give a value", 3);

	const input = workbench.locator(".quick-input-widget input").first();

	await input.fill("from a rule");
	await input.press("Enter");
	await expect(cell(workbench, "listed =")).toContainText("from a rule", { "timeout": 60_000 });

	// A run you start isn't under that rule: it still stops and asks.
	await codeOf(workbench).press("F5");
	await expect(workbench.locator(".notes-margin-cell .live-values-choice", { "hasText": "Allow" }).first()).toBeVisible({ "timeout": 60_000 });
});

test("Pin… keeps a value a past run saw there; cancelled, the line's buttons still work", async ({ page }) => {
	const program = "import { execSync } from \"node:child_process\";\nconst listed = execSync(\"ls\");\n";
	const workbench = await openEditor(page, { "pinned.mjs": program });

	await openFile(workbench, "pinned.mjs");

	// A run you start, given a value at its stop: that's the value seen there.
	await codeOf(workbench).press("F5");
	await workbench.locator(".notes-margin-cell .live-values-choice", { "hasText": "Give…" }).first().click({ "timeout": 60_000 });

	const input = workbench.locator(".quick-input-widget input").first();

	await input.fill("seen");
	await input.press("Enter");
	await expect(cell(workbench, "listed =")).toContainText("seen", { "timeout": 60_000 });

	// After an edit it's skipped, and says so.
	await retype(workbench, `${program}const total = 1 + 1;\n`);
	await expect(cell(workbench, "total =")).toContainText("2", { "timeout": 60_000 });
	await action(workbench, "Pin…").click({ "timeout": 30_000 });
	await expect(workbench.locator(".quick-input-list .monaco-list-row", { "hasText": "seen" }).first()).toBeVisible({ "timeout": 15_000 });
	await input.press("Escape");

	await action(workbench, "Pin…").click({ "timeout": 15_000 });
	await pickRow(workbench, "seen");
	await expect(cell(workbench, "listed =")).toContainText("seen", { "timeout": 60_000 });
	await expect(cell(workbench, "skipped")).toHaveCount(0, { "timeout": 30_000 });
});
