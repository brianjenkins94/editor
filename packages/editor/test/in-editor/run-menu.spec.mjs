/**
 * The Run menu (shell/run-menu.tsx, workbench/tasks.ts), as a person has it: it lists the file in the editor and the workspace's
 * scripts; a script runs in a terminal of its own; a dev server's script opens its preview, and asking again shows that rather
 * than starting a second. The same scripts are in Tasks: Run Task. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { devApp, openEditor, openFile, previewWindows } from "./editor.mjs";

const files = {
	...devApp("site", "from the menu"),
	"site/package.json": JSON.stringify({
		"name": "site",
		"scripts": { "dev": "vite" }
	}),
	"package.json": JSON.stringify({
		"name": "top",
		"scripts": { "greet": "node hello.mjs", "broken": "node broken.mjs" }
	}),
	"hello.mjs": "const total = 2 + 3;\n\nconsole.log(\"hello from a script\");\n",
	"broken.mjs": "process.exit(3);\n"
};

const menuButton = (page) => page.locator("#shell-run");
const item = (page, text) => page.locator("wa-dropdown-item", { "hasText": text });

async function choose(page, text) {
	await menuButton(page).click();
	await item(page, text).click();
}

test("the Run menu runs a script in a terminal of its own, and shows a service that's up rather than starting it twice", async ({ page }) => {
	const workbench = await openEditor(page, files);

	await openFile(workbench, "hello.mjs");

	// The scripts, in Run Task: by the keyboard, whose focus stays in the picker's input.
	const row = (text) => workbench.locator(".quick-input-list .monaco-list-row", { "hasText": text }).first();
	const picker = workbench.locator(".quick-input-widget input").first();

	await workbench.locator(".monaco-workbench").first().press("F1");
	await picker.fill(">Tasks: Run Task");
	await row("Tasks: Run Task").click();
	await expect(row("contributed")).toBeVisible({ "timeout": 30_000 });
	await picker.fill("run");
	await picker.press("Enter");
	await expect(row("site: dev")).toBeVisible({ "timeout": 30_000 });
	await expect(row("greet")).toBeVisible();
	await picker.press("Escape");

	// The file in the editor, then the workspace's scripts.
	await menuButton(page).click();
	await expect(item(page, "Run the file in the editor")).toBeVisible({ "timeout": 30_000 });
	await expect(item(page, "greet")).toBeVisible();
	await expect(item(page, "site: dev")).toBeVisible();

	// The file: in the debugger, what it computed beside it.
	await item(page, "Run the file in the editor").click();
	await expect(workbench.locator(".live-values-row", { "hasText": "total =" })).toContainText("5", { "timeout": 60_000 });

	// A script: its output, in its own terminal, ended with its exit code.
	await choose(page, "broken");
	await expect(workbench.locator(".xterm-rows").last()).toContainText("exit code: 3", { "timeout": 60_000 });

	await choose(page, "greet");
	await expect(workbench.locator(".xterm-rows").last()).toContainText("hello from a script", { "timeout": 60_000 });

	// A dev server's script: its preview. Asked again, it's that preview, not a second server.
	await choose(page, "site: dev");

	const shown = previewWindows(page);

	await expect(shown.frameLocator("iframe").locator("#app")).toHaveText("from the menu", { "timeout": 90_000 });
	await expect(shown).toHaveCount(1);
	await menuButton(page).click();

	const up = item(page, "show the preview, on :5173");

	await expect(up).toBeVisible({ "timeout": 30_000 });
	await up.click();
	await expect(shown).toHaveCount(1);
	await expect(shown).toHaveAttribute("label", "Preview :5173");
});
