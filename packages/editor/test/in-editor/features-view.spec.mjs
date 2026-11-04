/**
 * Features and their tests (workbench/features-view.ts), as a person has them: the ledger's features by their status, each
 * opening to its test files and how they last came out, and a button that runs them. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor } from "./editor.mjs";

const LEDGER = {
	"Adding": { "status": "active", "why": "it adds", "since": "2026-11-04", "what": "Adds two numbers.", "tests": ["add.test.mjs"] },
	"Breaking": { "status": "active", "why": "it breaks", "since": "2026-11-04", "what": "Fails on purpose.", "tests": ["break.test.mjs"] },
	"Nothing yet": { "status": "active", "why": "no tests", "since": "2026-11-04", "what": "Has no tests." },
	"Gone": { "status": "removed", "why": "out", "since": "2026-11-04", "what": "Was here." }
};

const files = {
	".silo/features.json": JSON.stringify(LEDGER, null, 2) + "\n",
	"add.test.mjs": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\n\ntest(\"adds\", () => {\n\tassert.equal(1 + 1, 2);\n});\n",
	"break.test.mjs": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\n\ntest(\"keeps\", () => {\n\tassert.ok(true);\n});\n\ntest(\"breaks\", () => {\n\tassert.equal(1, 2);\n});\n"
};

test("the ledger's features by status, each with its tests, run from there and how they came out", async ({ page }) => {
	const workbench = await openEditor(page, files);
	const row = (text) => workbench.locator(".part.sidebar [role='treeitem']", { "hasText": text });
	const run = async (text) => {
		// (its button shows on the row that's picked)
		await row(text).click();
		await row(text).locator("[aria-label*='Run Its Tests']").click();
	};

	await workbench.locator(".activitybar [aria-label='Features and Tests']").first().click();

	// By status; a feature with no tests says so.
	await expect(row(/^active/u)).toBeVisible({ "timeout": 30_000 });
	await expect(row(/^Adding/u)).toContainText("1 file", { "timeout": 15_000 });
	await expect(row(/^Adding/u)).toContainText("1 not run");
	await expect(row(/^Nothing yet/u)).toContainText("no tests");
	await expect(row(/^removed/u)).toBeVisible();
	await expect(row(/^Gone/u)).toHaveCount(0);

	// Run from the row: how it came out, on the feature and under it.
	await run(/^Adding/u);
	await expect(row(/^Adding/u)).toContainText("1 passing", { "timeout": 60_000 });

	await run(/^Breaking/u);
	await expect(row(/^Breaking/u)).toContainText("1 passing", { "timeout": 60_000 });
	await expect(row(/^Breaking/u)).toContainText("1 failing");

	// (by its arrow: a click on the row opens the file)
	await row(/^break\.test\.mjs/u).locator(".monaco-tl-twistie").click();
	await expect(row(/^breaks/u)).toBeVisible({ "timeout": 15_000 });
	await expect(row(/^keeps/u)).toBeVisible();
});
