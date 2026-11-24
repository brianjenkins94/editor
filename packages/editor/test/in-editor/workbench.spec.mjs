/**
 * The editor's own surfaces, as a person has them: a colour theme picked and the shell drawing in its colours
 * (workbench/theme-follow.ts), a fresh editor on the starter workspace (build/snapshot.ts) with the editor's settings as
 * its defaults, an extension loaded by its address (`?extension=`, workbench/extensions.ts), and a package's file served
 * by the service worker from the CDN, same-origin and isolated (coi-serviceworker.js, as a client hears it). What has no
 * UI — the theme following the system's, every context's report, signing in with the API stood in for — is
 * test/workbench/'s. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, problems, runCommand } from "./editor.mjs";

/** The page gone to `query`, once its editor's Explorer shows something. */
async function goTo(page, query) {
	await page.goto(`?${query}`);

	const workbench = page.frameLocator("iframe[title='editor']").frameLocator("iframe");

	await expect(workbench.getByRole("treeitem").first()).toBeVisible({ "timeout": 110_000 });

	return workbench;
}

/** "Preferences: Color Theme", `theme` picked. */
async function pickTheme(workbench, theme) {
	const input = workbench.locator(".quick-input-widget input[type='text'], .quick-input-widget input:not([type])").first();

	// (in the palette, "Browse Color Themes in Marketplace" comes before it: down to it, as a person goes)
	const command = workbench.locator(".quick-input-list .monaco-list-row.focused", { "hasText": "Preferences: Color Theme" });

	await workbench.locator(".monaco-workbench").first().press("F1");
	await input.fill(">Preferences: Color Theme");
	await expect(workbench.locator(".quick-input-list .monaco-list-row", { "hasText": "Preferences: Color Theme" }).first()).toBeVisible({ "timeout": 15_000 });

	for (let down = 0; down < 5 && await command.count() === 0; down += 1) {
		await input.press("ArrowDown");
	}

	await expect(command).toHaveCount(1);
	await input.press("Enter");
	// (the picker, its list drawn only as far as it shows: filtered to the theme, it's the one Enter picks)
	await expect(workbench.locator(".quick-input-list .monaco-list-row", { "hasText": "Light Modern" }).first()).toBeVisible({ "timeout": 15_000 });
	await input.fill(theme);
	await expect(workbench.locator(".quick-input-list .monaco-list-row").first()).toContainText(theme, { "timeout": 15_000 });
	await input.press("Enter");
}

test("a colour theme picked: VS Code draws in it, and so does the shell", async ({ page }) => {
	const workbench = await openEditor(page, { "a.txt": "a\n" });

	await pickTheme(workbench, "Dark+");
	await expect(page.locator("body")).toHaveCSS("--vscode-editor-background", /^#1e1e1e$/iu, { "timeout": 30_000 });

	await pickTheme(workbench, "Light+");
	await expect(page.locator("body")).toHaveCSS("--vscode-editor-background", /^#ffffff$/iu, { "timeout": 30_000 });
});

test("a fresh editor opens on the starter workspace", async ({ page }) => {
	const workbench = await goTo(page, `instance=fresh-${crypto.randomUUID().slice(0, 8)}`);

	for (const name of ["package.json", "tsconfig.json", "index.html", "src", "apps"]) {
		await expect(workbench.locator(`[role='treeitem'][aria-level='1'][aria-label='${name}']`)).toBeVisible({ "timeout": 30_000 });
	}
});

test("the editor's settings as its defaults: TypeScript formatted on save, by ESLint, and JSON not", async ({ page }) => {
	const workbench = await openEditor(page, { "fmt.ts": "var a=1\nexport { a }\n", "fmt.json": "{\"a\":1}\n" });
	const lines = workbench.locator(".editor-instance .view-lines");

	await openFile(workbench, "fmt.json");
	await codeOf(workbench).press("End");
	await codeOf(workbench).pressSequentially(" ");
	await codeOf(workbench).press("ControlOrMeta+s");
	await expect(workbench.locator(".tab.dirty")).toHaveCount(0, { "timeout": 30_000 });
	await expect(lines).toContainText("{\"a\":1}");

	// (ESLint, its formatter, up first: a save before it answers isn't formatted. Its first problem says it's there.)
	await openFile(workbench, "fmt.ts");
	await expect((await problems(workbench)).filter({ "hasText": "no-var" })).toHaveCount(1, { "timeout": 90_000 });
	await openFile(workbench, "fmt.ts");
	await codeOf(workbench).press("End");
	await codeOf(workbench).pressSequentially(" ");
	await codeOf(workbench).press("ControlOrMeta+s");
	await expect(lines).toContainText("const a = 1", { "timeout": 60_000 });
});

test("an extension loaded by its address (`?extension=`) runs in the editor", async ({ page }) => {
	const workbench = await openEditor(page, { "a.txt": "a\n" }, { "extension": "/test/fixtures/url-extension/" });

	await runCommand(workbench, "Hello from a URL");
	await expect(workbench.locator(".notification-toast", { "hasText": "hello from a URL" })).toBeVisible({ "timeout": 60_000 });
});

test("the service worker serves a package's file from the CDN: same-origin, isolated", async ({ page, request }) => {
	await openEditor(page, { "a.txt": "a\n" });

	const answer = await request.get("/workspace/node_modules/react/package.json?v=18.3.1");

	expect(answer.status()).toBe(200);
	expect(answer.headers()["cross-origin-opener-policy"]).toBe("same-origin");
	expect((await answer.json()).name).toBe("react");
});
