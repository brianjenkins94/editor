/**
 * Live values in the margin (extensions/margin/values.ts), as a person has them: run a file and each line shows what it
 * computed, a column per turn of a loop, one call of a function called more than once; they stay on their code through an
 * edit, and a run that dies says where. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, moved, openEditor, openFile } from "./editor.mjs";

const PROGRAM = `const total = 2 + 3;
let sum = 0;

for (const each of [1, 2, 3]) {
	sum += each;
}

function twice(value) {
	return value * 2;
}

twice(4);
twice(5);
`;
const files = {
	"program.mjs": PROGRAM,
	"throws.mjs": "const before = 1;\nthrow new Error(\"no more\");\n",
	"broken.mjs": "const before = 1;\n});\n"
};

test("a run's values beside the code: a column per turn, a call picked, following its code; and where a run died", async ({ page }) => {
	const workbench = await openEditor(page, files);
	const row = (label) => workbench.locator(".live-values-row", { "hasText": label });
	const start = async () => codeOf(workbench).press("F5");

	await openFile(workbench, "program.mjs");
	await start();

	// At the top level, the value. In a loop, a column per turn.
	await expect(row("total =")).toContainText("5", { "timeout": 60_000 });
	await expect(row("sum =").first()).toContainText("0");
	await expect(row("each =").locator(".live-values-cell.turn")).toHaveText([/1/u, /2/u, /3/u]);
	await expect(row("sum =").last().locator(".live-values-cell.turn")).toHaveText([/1/u, /3/u, /6/u]);

	// A click holds a turn's column; another lets it go.
	const cell = row("each =").locator(".live-values-cell.turn").nth(1);

	await cell.click();
	await expect(cell).toHaveClass(/held/u);
	await row("each =").locator(".live-values-cell.turn").nth(1).click();
	await expect(row("each =").locator(".live-values-cell.turn").nth(1)).not.toHaveClass(/held/u);

	// A function called twice shows its latest; the one before is a click away.
	await expect(row("return")).toContainText("10");
	await expect(workbench.locator(".live-values-row", { "hasText": "2/2" })).toBeVisible();
	await workbench.locator(".live-values-cell", { "hasText": "‹" }).click();
	await expect(row("return")).toContainText("8");
	await expect(workbench.locator(".live-values-row", { "hasText": "1/2" })).toBeVisible();

	// Pushed down by an edit, level with its code.
	const topOf = async (locator) => (await locator.boundingBox()).y;
	const before = await topOf(row("total ="));

	await codeOf(workbench).press("ControlOrMeta+Home");
	await codeOf(workbench).pressSequentially("\n");
	await expect(row("total =")).toBeVisible({ "timeout": 15_000 });
	await moved(page, async () => topOf(row("total =")), before);

	// Its code gone, so is its value.
	await codeOf(workbench).pressSequentially("// ");
	await expect(row("total =")).toHaveCount(0, { "timeout": 15_000 });
	await expect(row("each =")).toBeVisible();

	// A run that throws: ✕ on the line it threw, saying what. The values it got to stay.
	await openFile(workbench, "throws.mjs");
	await start();
	await expect(workbench.locator(".notes-margin-mark.run-crashed")).toHaveAttribute("title", /no more/u, { "timeout": 60_000 });
	await expect(row("before =")).toContainText("1");

	// A file that doesn't parse: nothing ran, so ✕ where the parser stopped, and nothing else.
	await openFile(workbench, "broken.mjs");
	await start();
	await expect(workbench.locator(".notes-margin-mark.run-crashed")).toHaveAttribute("title", /SyntaxError.*broken\.mjs:2:1/u, { "timeout": 60_000 });
	await expect(row("before =")).toHaveCount(0);
});

test("at a stop, a line's latest value is VS Code's own inline value too", async ({ page }) => {
	const workbench = await openEditor(page, files);

	await openFile(workbench, "program.mjs");
	await codeOf(workbench).press("ArrowDown");
	await codeOf(workbench).press("ArrowDown");
	await codeOf(workbench).press("ArrowDown");
	await codeOf(workbench).press("ArrowDown");
	await codeOf(workbench).press("F9");
	await codeOf(workbench).press("F5");

	await expect(workbench.locator(".live-values-row", { "hasText": "total =" })).toContainText("5", { "timeout": 60_000 });
	await expect(workbench.locator(".debug-inline-value", { "hasText": "total = 5" })).toBeVisible({ "timeout": 15_000 });

	// Stopped there: the run's ended, and the Margin says where it was.
	await codeOf(workbench).press("Shift+F5");
	await expect(workbench.locator(".notes-margin-mark.run-stopped")).toHaveCount(1, { "timeout": 15_000 });
});
