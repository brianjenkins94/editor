/**
 * Features and tests (workbench/features-view.tsx), as a person has them: the ledger's features with their test files under
 * them, each saying what kind it is, and once run, when it passed and failed, how long it takes, its effects, and if it can't run
 * beside the others, why. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, runCommand } from "./editor.mjs";

const entry = (what, tests) => ({ "status": "active", "why": what, "since": "2026-11-04", "what": what, ...tests === undefined ? {} : { "tests": tests } });
const unit = (body) => `import assert from "node:assert/strict";\nimport * as fs from "node:fs";\nimport { test } from "node:test";\n\n${body}\n`;
const LEDGER = {
	"Adding": entry("Adds.", ["add.test.mjs"]),
	"Adding too": entry("Adds, again.", ["again.test.mjs"]),
	"Multiplying": entry("Multiplies.", ["times.test.mjs"]),
	"Breaking": entry("Fails on purpose.", ["break.test.mjs"]),
	"Nothing yet": entry("Has no tests."),
	"Viewing": entry("A suite and a spec.", ["suite.mjs", "view.spec.mjs"]),
	"Writing": entry("Two tests on one file.", ["one.test.mjs", "two.test.mjs"]),
	"Gone": { "status": "removed", "why": "out", "since": "2026-11-04", "what": "Was here." }
};
const WRITES = "test(\"writes\", () => {\n\tfs.writeFileSync(\"/workspace/shared.txt\", \"x\");\n\tassert.ok(fs);\n});";
const files = {
	".silo/features.json": JSON.stringify(LEDGER, null, 2) + "\n",
	"math.mjs": "export function add(one, other) {\n\treturn one + other;\n}\n\nexport function times(one, other) {\n\treturn one * other;\n}\n",
	"add.test.mjs": unit("import { add } from \"./math.mjs\";\n\ntest(\"adds\", () => {\n\tassert.equal(add(1, 1), 2);\n});"),
	"again.test.mjs": unit("import { add } from \"./math.mjs\";\n\ntest(\"adds again\", () => {\n\tassert.equal(add(2, 2), 4);\n});"),
	"times.test.mjs": unit("import { times } from \"./math.mjs\";\n\ntest(\"times\", () => {\n\tassert.equal(times(2, 2), 4);\n});"),
	"break.test.mjs": unit("test(\"keeps\", () => {\n\tassert.ok(true);\n});\n\ntest(\"breaks\", () => {\n\tassert.equal(1, 2);\n});"),
	"suite.mjs": "import { startSession } from \"./architecture-harness.mjs\";\n",
	"view.spec.mjs": "import { test } from \"@playwright/test\";\n",
	"one.test.mjs": unit(WRITES),
	"two.test.mjs": unit(WRITES)
};

test("each feature's tests, what kind they are, run from there, how they came out, and which can't run in parallel", async ({ page }) => {
	const workbench = await openEditor(page, files);
	const row = (text) => workbench.locator(".fv-table tbody tr", { "hasText": text });
	const run = async (file) => row(file).locator(`wa-button[aria-label='Run ${file}']`).click();
	const allow = async () => {
		await workbench.locator(".notification-toast").getByRole("button", { "name": "Allow" }).click({ "timeout": 30_000 });
	};

	await runCommand(workbench, "Features and Tests: Show");

	// By feature, each file saying what it is; a feature with no tests isn't shown until asked for.
	await expect(row("add.test.mjs")).toContainText("unit", { "timeout": 30_000 });
	await expect(row("add.test.mjs")).toContainText("not run");
	await expect(row("view.spec.mjs")).toContainText("UI spec");
	await expect(row("Nothing yet")).toHaveCount(0);
	await expect(row("Gone")).toHaveCount(0);

	// What runs from outside says so, in the column that's otherwise quiet, and has no button.
	await expect(row("suite.mjs")).toContainText("browser suite");
	await expect(row("suite.mjs")).toContainText("started from outside");
	await expect(row("suite.mjs").locator("wa-button")).toHaveCount(0);
	await expect(row("add.test.mjs").locator("wa-badge")).toHaveCount(0);

	// Run: when it passed, and how long.
	await run("add.test.mjs");
	await expect(row("add.test.mjs").locator("wa-relative-time")).toHaveCount(1, { "timeout": 60_000 });
	await expect(row("add.test.mjs")).not.toContainText("not run");

	// One that fails says so on its feature, and when; opened, each test.
	await run("break.test.mjs");
	await expect(row("Breaking")).toContainText("1 failing", { "timeout": 60_000 });
	await row("break.test.mjs").locator(".fv-toggle").click();
	await expect(row("keeps")).toBeVisible();
	await expect(row("breaks")).toContainText("fail");

	// How much each reaches, and how much only it does.
	await run("times.test.mjs");
	await expect(row("times.test.mjs")).toContainText(/\d+ lines · \d+ only here/u, { "timeout": 60_000 });
	await run("again.test.mjs");
	await expect(row("again.test.mjs")).toContainText("nothing only here", { "timeout": 60_000 });
	await expect(row("add.test.mjs")).toContainText("nothing only here");

	// A save touches what reached that file, not what didn't, and they run from there.
	await openFile(workbench, "math.mjs");
	await codeOf(workbench).pressSequentially("// ");
	await codeOf(workbench).press("ControlOrMeta+s");
	await expect(row("add.test.mjs")).toContainText("touched", { "timeout": 30_000 });
	await expect(row("break.test.mjs")).not.toContainText("touched");

	const touched = workbench.locator("wa-button[aria-label='Run touched']");

	await touched.click();
	await expect(touched).toHaveCount(0, { "timeout": 60_000 });
	await expect(row("add.test.mjs")).not.toContainText("touched");

	// Two that write one file: each says it can't run in parallel, and why.
	await run("one.test.mjs");
	await allow();
	await expect(row("one.test.mjs").locator("wa-badge", { "hasText": "fs:write" })).toHaveCount(1, { "timeout": 60_000 });
	await run("two.test.mjs");
	await expect(row(/^\S+ two\.test\.mjs/u)).toContainText("writes /workspace/shared.txt, as one.test.mjs does", { "timeout": 60_000 });
	await expect(row(/^\S+ one\.test\.mjs/u)).toContainText("writes /workspace/shared.txt, as two.test.mjs does");
});
