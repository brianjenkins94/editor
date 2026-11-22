/**
 * Vouches (extensions/history/vouches.ts, workbench/test-runs.ts's step before a commit; packages/silo/README.md,
 * *Vouches*), as a person has them: a test run, its code edited, and the commit runs it again first (decision 12), says
 * so, and carries its pass for CI. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, openFile, openTerminal, READABLE_TERMINAL, retype, runCommand } from "./editor.mjs";

const files = {
	...READABLE_TERMINAL,
	".silo/features.json": JSON.stringify({ "Adding": { "status": "active", "why": "Adds.", "since": "2026-11-22", "what": "Adds.", "paths": ["math.mjs"], "tests": ["add.test.mjs"] } }, null, 2) + "\n",
	"math.mjs": "export function add(one, other) {\n\treturn one + other;\n}\n",
	"add.test.mjs": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\n\nimport { add } from \"./math.mjs\";\n\ntest(\"adds\", () => {\n\tassert.equal(add(1, 1), 2);\n});\n"
};

test("a touched test that hasn't run since its code changed runs before the commit, and the commit carries its pass", async ({ page }) => {
	const workbench = await openEditor(page, files);
	const row = (text) => workbench.locator(".fv-table tbody tr", { "hasText": text });

	// Run once, so what it reaches is known.
	await runCommand(workbench, "Features and Tests: Show");
	await row("add.test.mjs").locator("wa-button[aria-label='Run add.test.mjs']").click();
	await expect(row("add.test.mjs").locator("wa-relative-time")).toHaveCount(1, { "timeout": 60_000 });

	// Its code changed since: touched.
	await openFile(workbench, "math.mjs");
	await retype(workbench, "export function add(one, other) { return other + one; }\n");

	// Committed from Source Control: it runs first, and says so.
	await runCommand(workbench, "Source Control: Focus on Changes View");
	await workbench.locator(".scm-editor .monaco-editor").first().click();
	await workbench.locator(".scm-editor .native-edit-context").first().pressSequentially("adds the other way");
	await workbench.locator(".scm-editor .native-edit-context").first().press("ControlOrMeta+Enter");
	await expect(workbench.locator(".notification-list-item-message", { "hasText": "Ran the touched tests that hadn't run since their code changed: 1 passed, vouched for." }).first()).toBeVisible({ "timeout": 90_000 });

	// The commit carries the pass, held to the files it ran; none waits for the next.
	const { input, output } = await openTerminal(workbench);

	await input.pressSequentially("git status\n");
	await expect(output).toContainText("nothing to commit", { "timeout": 30_000 });
	await input.pressSequentially("grep -o '\"test\":\"add.test.mjs › [a-z]*\",\"outcome\":\"[a-z]*\"' .silo/vouches/*.jsonl\n");
	await expect(output).toContainText("\"test\":\"add.test.mjs › adds\",\"outcome\":\"pass\"", { "timeout": 30_000 });
	await input.pressSequentially("grep -o '\"math.mj[s]\"' .silo/vouches/*.jsonl\n");
	await expect(output).toContainText("\"math.mjs\"", { "timeout": 30_000 });
	await input.pressSequentially("ls .silo/local; echo listed\n");
	await expect(output).toContainText("listed", { "timeout": 30_000 });
	await expect(output).not.toContainText("vouches.jsonl");
});
