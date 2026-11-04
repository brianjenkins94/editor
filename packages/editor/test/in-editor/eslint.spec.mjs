/**
 * ESLint in the editor (extensions/eslint), as a person has it: real ESLint on the file that's open, its problems in Problems,
 * fixes on save, a folder's own config, a config that won't load said on itself, and silence when it's turned off. Runs in
 * the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, problems } from "./editor.mjs";

/** What ESLint takes to start (its toolchain, from the build), the first time; less than a run may sit quiet (test-runs.ts). */
const LINTED = { "timeout": 90_000 };

test("an open file is linted by the preset where the workspace has no config: each problem by its rule, and where", async ({ page }) => {
	const workbench = await openEditor(page, { "lint/probe.ts": "export function run(): void {\n\tdebugger;\n}\n" });

	await openFile(workbench, "lint/probe.ts");

	const rows = await problems(workbench);
	const found = rows.filter({ "hasText": "no-debugger" });

	await expect(found).toHaveCount(1, LINTED);
	await expect(found).toContainText("[Ln 2, Col 2]");
});

test("a tsconfig that can't be read is said on the file linted, where a message with no line goes on the first", async ({ page }) => {
	const workbench = await openEditor(page, {
		"tsconfig.json": "{ \"extends\": \"./missing.json\" }\n",
		"lint/probe.ts": "export const one = 1;\n"
	});

	await openFile(workbench, "lint/probe.ts");

	const rows = await problems(workbench);

	await expect(rows.filter({ "hasText": "Parsing error" })).toHaveCount(1, LINTED);
});

test("saving fixes what can be fixed", async ({ page }) => {
	const workbench = await openEditor(page, { "lint/fix.ts": "export const other = 2;\n" });

	await openFile(workbench, "lint/fix.ts");
	await codeOf(workbench).pressSequentially("var value = 1; export { value }; ");

	const lines = workbench.locator(".editor-instance .view-lines");

	await expect(lines).toContainText("var value");

	// (ESLint up first: a save before it answers isn't fixed. Its first problem says it's there.)
	const rows = await problems(workbench);

	await expect(rows.filter({ "hasText": "no-var" })).toHaveCount(1, LINTED);
	await openFile(workbench, "lint/fix.ts");
	await codeOf(workbench).press("ControlOrMeta+s");
	await expect(lines).not.toContainText("var value", { "timeout": 60_000 });
	await expect(lines).toContainText(/(?:const|let)\s+value\s*=\s*1/u);
});

test("a folder's own eslint.config.js lints the files under it, and only its rules", async ({ page }) => {
	// (no-magic-numbers: off in the preset, so only this config says it)
	const workbench = await openEditor(page, {
		"own/eslint.config.js": "export default [{ \"rules\": { \"no-magic-numbers\": \"error\" } }];\n",
		"own/a.js": "export const minutes = 60 * 24;\n"
	});

	await openFile(workbench, "own/a.js");

	const rows = await problems(workbench);

	await expect(rows.filter({ "hasText": "no-magic-numbers" })).toHaveCount(2, LINTED);
	await expect(rows.filter({ "hasText": "eslint" }).filter({ "hasNotText": "no-magic-numbers" })).toHaveCount(0);
});

test("a config that fails to load says why, on itself, and the preset lints meanwhile", async ({ page }) => {
	const workbench = await openEditor(page, {
		"broken/eslint.config.js": "throw new Error(\"broken on purpose\");\n",
		"broken/b.ts": "export function run(): void {\n\tdebugger;\n}\n"
	});

	await openFile(workbench, "broken/b.ts");

	const rows = await problems(workbench);

	await expect(rows.filter({ "hasText": "no-debugger" })).toHaveCount(1, LINTED);
	await expect(rows.filter({ "hasText": /couldn't load this config, so the preset lints meanwhile/u })).toHaveCount(1, LINTED);
});

test("eslint.enable, as it's saved: off takes its problems away, though the file is still checked, and on brings them back", async ({ page }) => {
	const workbench = await openEditor(page, {
		".vscode/settings.json": "{}\n",
		"tsconfig.json": "{}\n",
		"lint/off.ts": "export function run(): void {\n\tdebugger;\n}\nexport const wrong: number = \"text\";\n"
	});

	await openFile(workbench, "lint/off.ts");

	const rows = await problems(workbench);
	const eslint = rows.filter({ "hasText": "no-debugger" });

	await expect(eslint).toHaveCount(1, LINTED);

	await openFile(workbench, ".vscode/settings.json");
	await codeOf(workbench).pressSequentially("{ \"eslint.enable\": false } // ");
	await codeOf(workbench).press("ControlOrMeta+s");
	await expect(eslint).toHaveCount(0, { "timeout": 30_000 });
	await expect(rows.filter({ "hasText": "not assignable" })).toHaveCount(1, LINTED);

	await codeOf(workbench).press("Home");
	await codeOf(workbench).pressSequentially("// ");
	await codeOf(workbench).press("ControlOrMeta+s");
	await expect(eslint).toHaveCount(1, { "timeout": 30_000 });
});
