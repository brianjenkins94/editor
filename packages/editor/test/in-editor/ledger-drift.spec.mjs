/**
 * Feature ledger drift in Problems (extensions/history), as a person has it: a code file no feature owns is a problem on
 * it, saying both ways out — change the code, or the decision — and named in the ledger, it goes. Runs in the editor:
 * test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, openFile, problems, retype } from "./editor.mjs";

const greeting = (paths) => ({ "Greeting": { "status": "active", "why": "it says hello", "since": "2026-11-24", "what": "Says hello.", "paths": paths, "tests": ["greet.test.mjs"] } });

test("a file no feature owns is a problem on it, saying both ways out; named in the ledger, it goes", async ({ page }) => {
	const workbench = await openEditor(page, {
		".silo/features.json": JSON.stringify(greeting(["greet.mjs"]), null, 2) + "\n",
		"greet.mjs": "export const greet = () => \"hello\";\n",
		"greet.test.mjs": "import assert from \"node:assert/strict\";\nimport { test } from \"node:test\";\nimport { greet } from \"./greet.mjs\";\n\ntest(\"greets\", () => {\n\tassert.equal(greet(), \"hello\");\n});\n",
		"stray.mjs": "export const stray = 1;\n"
	});
	const rows = await problems(workbench);
	const stray = rows.filter({ "hasText": "unowned file: stray.mjs is owned by no feature" });

	await expect(stray).toHaveCount(1, { "timeout": 120_000 });
	await expect(stray).toContainText("change the code: delete it");
	await expect(stray).toContainText("or the decision: name it in the `paths` of the feature it's part of");
	await expect(rows.filter({ "hasText": "greet.mjs is owned" })).toHaveCount(0);

	await openFile(workbench, ".silo/features.json");
	await retype(workbench, JSON.stringify(greeting(["greet.mjs", "stray.mjs"])));
	await expect(rows.filter({ "hasText": "stray.mjs" })).toHaveCount(0, { "timeout": 60_000 });
});
