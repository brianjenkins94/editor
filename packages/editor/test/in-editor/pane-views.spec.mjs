/**
 * Pane views (ARCHITECTURE.md, *Extension points* 4), as a person has them: a tab in the pane beside the editor, provided as data
 * by an extension loaded from outside the editor (test/fixtures/pane-view, by its address), its items level with the code
 * each is about, its buttons and input running its commands, and items it adds into the Margin. And the same, as VS Code's own
 * annotations, the pane hidden. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, openFile, runCommand } from "./editor.mjs";

const PROBE = "// a probe\nconst x = [1, 22];\nconst longer = 333;\nconst typed = \"\";\nconst z = 3;\nconst later = 4;\n";
const LOADED = { "timeout": 60_000 };

test("an extension's pane view: its tab, its items level with their code, its buttons and input, and natively, the pane hidden", async ({ page }) => {
	const workbench = await openEditor(page, { "pane-probe.js": PROBE }, { "extension": "/test/fixtures/pane-view/" });

	await openFile(workbench, "pane-probe.js");

	const cell = (text) => workbench.locator(".notes-margin-cell", { "hasText": text });

	// Into the Margin: the extension's item among the Margin's own.
	await expect(cell("into the margin")).toHaveAttribute("data-line", "0", LOADED);

	// Its own tab.
	await workbench.locator(".notes-margin-tab", { "hasText": "Probe" }).click();
	await expect(cell("longer =")).toHaveAttribute("data-line", "2", LOADED);
	await expect(cell("hello")).toHaveAttribute("data-line", "0");
	await expect(cell("x =")).toHaveAttribute("data-line", "1");
	await expect(cell("into the margin")).toHaveCount(0);

	// Rows on consecutive lines line their labels up.
	const labels = await workbench.locator(".notes-margin-cell .live-values-label").allTextContents();

	expect(labels.filter((label) => label.trim() === "x =" || label.trim() === "longer =")).toEqual(["x =     ", "longer ="]);
	await expect(workbench.locator(".notes-margin-group-label")).toHaveText("a stepran");
	await expect(workbench.locator(".notes-margin-mark.coverage-ran[title='ran twice']")).toHaveCount(1);

	// Its button runs its command, and its content says so.
	await workbench.locator(".notes-margin-cell .live-values-choice", { "hasText": "Click" }).click();
	await expect(cell("clicked a")).toBeVisible({ "timeout": 15_000 });

	// Its input submits what was typed.
	const input = workbench.locator(".notes-margin-cell .live-values-input input");

	await input.fill("hi there");
	await input.press("Enter");
	await expect(input).toHaveValue("hi there", { "timeout": 15_000 });

	// As VS Code's own annotations, the pane hidden: a row as an inlay hint, prose, buttons, the input and the card as CodeLenses.
	await runCommand(workbench, "Pane: Switch Between Beside the Code and Annotations");
	await expect(workbench.locator(".notes-margin-cell")).toHaveCount(0, { "timeout": 15_000 });

	const lenses = workbench.locator(".editor-instance .codelens-decoration");

	await expect(lenses.filter({ "hasText": "Click" })).not.toHaveCount(0, LOADED);
	await expect(lenses.filter({ "hasText": "typed hi there ✎" })).not.toHaveCount(0);
	await expect(lenses.filter({ "hasText": "a step · ran" })).not.toHaveCount(0);
	await expect(lenses.filter({ "hasText": /^hello/u })).not.toHaveCount(0);
	await expect(workbench.locator(".editor-instance .view-lines")).toContainText("x = 22", LOADED);

	// Prose, whole, on hover.
	await workbench.locator(".editor-instance .view-line span span", { "hasText": "a probe" }).hover();
	await expect(workbench.locator(".monaco-hover", { "hasText": "hello" })).not.toHaveCount(0, { "timeout": 15_000 });

	// And back, then to the Margin.
	await runCommand(workbench, "Pane: Switch Between Beside the Code and Annotations");
	await expect(cell("longer =")).toBeVisible(LOADED);
	await workbench.locator(".notes-margin-tab", { "hasText": "Margin" }).click();
	await expect(cell("into the margin")).toBeVisible(LOADED);
});
