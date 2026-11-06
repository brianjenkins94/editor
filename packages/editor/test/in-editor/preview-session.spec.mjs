/**
 * A dev server in Run and Debug (workbench/preview-session.ts), as a person has it: it's there once it's up, with what it says in the
 * Debug Console, Restart starts it over, Stop stops it, and however it stops the session goes. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { devApp, openEditor, openFile, openTerminal, previewWindows, retype, runCommand } from "./editor.mjs";

const files = devApp("sessionapp", "served");

test("a dev server is a session in Run and Debug: what it says in the Debug Console, a Stop button, and it goes when the server does", async ({ page }) => {
	const workbench = await openEditor(page, files);
	const toolbar = (name) => workbench.locator(`.debug-toolbar .action-label[aria-label^='${name}']`);
	const said = (text) => workbench.locator(".repl .monaco-list-row", { "hasText": text }).first();

	await openFile(workbench, "sessionapp/src/main.ts");

	const { input } = await openTerminal(workbench);

	await input.pressSequentially("cd sessionapp && vite\n");
	await expect(previewWindows(page).frameLocator("iframe").locator("#app")).toHaveText("served", { "timeout": 90_000 });

	await expect(toolbar("Stop")).toBeVisible({ "timeout": 30_000 });
	// Nothing in it to pause.
	await expect(workbench.locator(".debug-toolbar .action-label.disabled[aria-label^='Pause']")).toHaveCount(1);
	await runCommand(workbench, "Debug Console: Focus on Debug Console View");
	await expect(said("Local:")).toBeVisible({ "timeout": 30_000 });

	// What it says from then on, too.
	await retype(workbench, "document.querySelector(\"#app\")!.textContent = \"saved\";\n");
	await expect(said("[vite]")).toBeVisible({ "timeout": 60_000 });

	// Restarted there: the old server's windows go, and there's one on the new.
	await previewWindows(page).locator("[title='Another window onto this server']").click();
	await expect(previewWindows(page)).toHaveCount(2);
	await toolbar("Restart").click();
	await expect(previewWindows(page)).toHaveCount(1, { "timeout": 60_000 });
	await expect(previewWindows(page).frameLocator("iframe").locator("#app")).toHaveText("saved", { "timeout": 90_000 });

	// Stopped there: the server's stopped, and its windows go with it.
	await toolbar("Stop").click();
	await expect(previewWindows(page)).toHaveCount(0, { "timeout": 30_000 });
	await expect(toolbar("Stop")).toBeHidden({ "timeout": 30_000 });

	// Stopped anywhere else: the session goes.
	const { "input": another } = await openTerminal(workbench);

	await another.pressSequentially("cd sessionapp && vite\n");
	await expect(previewWindows(page).frameLocator("iframe").locator("#app")).toHaveText("saved", { "timeout": 90_000 });
	await expect(toolbar("Stop")).toBeVisible({ "timeout": 30_000 });
	await previewWindows(page).locator(".app-window-controls [title='Close'], .app-window-controls [aria-label='Close']").click();
	await expect(toolbar("Stop")).toBeHidden({ "timeout": 30_000 });
});
