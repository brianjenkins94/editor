/**
 * Coverage in the gutter (extensions/margin/coverage.ts), as a person has it: run tests, and beside the code each line says whether
 * it ran. What one run missed another can reach, and the marks stay on their code as it's edited. Runs in the editor:
 * test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, retype, runCommand } from "./editor.mjs";

const unit = (name, body) => `import assert from "node:assert/strict";\nimport { test } from "node:test";\nimport { add, times } from "./math.mjs";\n\ntest("${name}", () => {\n\t${body}\n});\n`;
const files = {
	".silo/features.json": JSON.stringify({ "Math": { "status": "active", "why": "it adds", "since": "2026-11-04", "what": "Math.", "tests": ["add.test.mjs", "times.test.mjs"] } }) + "\n",
	"math.mjs": "export function add(one, other) {\n\treturn one + other;\n}\n\nexport function times(one, other) {\n\treturn one * other;\n}\n",
	"add.test.mjs": unit("adds", "assert.equal(add(1, 1), 2); assert.ok(times);"),
	"times.test.mjs": unit("times", "assert.equal(times(2, 2), 4); assert.ok(add);")
};

test("after a run, each line says whether it ran; a line no run reached says so; marks stay on their code as it's edited", async ({ page }) => {
	const workbench = await openEditor(page, files);
	const row = (text) => workbench.locator(".fv-table tbody tr", { "hasText": text });
	const marks = (kind) => workbench.locator(`.notes-margin-mark.coverage-${kind}`);
	const topOf = async (locator) => (await locator.boundingBox()).y;

	/** A test file run from the table, the panel given the room for it and then taken back, to see the code. */
	const run = async (file) => {
		await runCommand(workbench, "Features and Tests: Show");
		await runCommand(workbench, "View: Toggle Maximized Panel");
		await row(file).locator(`wa-button[aria-label='Run ${file}']`).click();
		await expect(row(file).locator("wa-relative-time")).not.toHaveCount(0, { "timeout": 60_000 });
		await runCommand(workbench, "View: Toggle Maximized Panel");
		await runCommand(workbench, "View: Hide Panel");
	};

	await openFile(workbench, "math.mjs");
	await run("add.test.mjs");

	// The body of `times` didn't run; the body of `add` did, once.
	await expect(marks("missed")).toHaveCount(1, { "timeout": 60_000 });
	await expect(marks("missed")).toHaveAttribute("title", "Didn't run");
	await expect(workbench.locator(".notes-margin-mark.coverage-ran[title='Ran 1×']").first()).toBeVisible();

	// Another test reaches it: no line is left that no run reached.
	await run("times.test.mjs");
	await expect(marks("missed")).toHaveCount(0, { "timeout": 60_000 });

	// A line pushed down by an edit: its mark goes with it.
	const before = await topOf(marks("ran").last());

	await codeOf(workbench).pressSequentially("// a note\n");
	await expect(workbench.locator(".tab.dirty")).toHaveCount(1);
	await page.waitForTimeout(1500);
	await expect(marks("ran").last()).toBeVisible({ "timeout": 15_000 });
	expect(await topOf(marks("ran").last())).toBeGreaterThan(before);

	// Reformatted, nothing lost: BABLR finds each statement by its code, not its place.
	const count = await marks("ran").count();

	await retype(workbench, "// a note\nexport function add(one, other) { return one + other; }\n\nexport function times(one, other) { return one * other; }\n");
	await page.waitForTimeout(1500);
	await expect(marks("ran")).not.toHaveCount(0, { "timeout": 15_000 });
	expect(await marks("ran").count()).toBeLessThanOrEqual(count);

	// A statement edited past recognizing loses its mark until it runs again.
	await retype(workbench, "export function added(one, other) { return one - other + 7; }\n");
	await expect(marks("ran")).toHaveCount(0, { "timeout": 15_000 });
});
