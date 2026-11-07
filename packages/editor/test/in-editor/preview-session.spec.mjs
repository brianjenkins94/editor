/**
 * A dev server in Run and Debug (workbench/preview-session.ts), as a person has it: it's there once it's up, with what it says in the
 * Debug Console, Restart starts it over, Stop stops it, and however it stops the session goes. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { devApp, openEditor, openFile, openTerminal, previewWindows, retype, runCommand } from "./editor.mjs";

const files = devApp("sessionapp", "served");

/** What the debugger shows: the toolbar's buttons, the sessions in the Debug Console's list, the status bar's debug item. To say
 *  why Stop isn't there when it isn't (2 of 8 runs on CI, 2026-11-07; never here). */
async function debugShown(workbench) {
	const texts = async (locator, attribute) => {
		const found = [];

		for (let index = 0; index < Math.min(await locator.count(), 12); index += 1) {
			found.push(attribute === undefined
				? await locator.nth(index).textContent()
				: await locator.nth(index).getAttribute(attribute));
		}

		return found;
	};

	return {
		"toolbar": await texts(workbench.locator(".debug-toolbar .action-label"), "aria-label"),
		"sessions": await texts(workbench.locator(".panel .monaco-select-box option")),
		"status": await texts(workbench.locator(".statusbar-item[id*='debug'], .statusbar-item.debug"), "aria-label")
	};
}

/** Stop on the toolbar, or why not. */
async function stopShown(workbench, toolbar) {
	try {
		await expect(toolbar("Stop")).toBeVisible({ "timeout": 30_000 });
	} catch (error) {
		throw new Error(`${String(error)}; the debugger: ${JSON.stringify(await debugShown(workbench))}`, { "cause": error });
	}
}

test("a dev server is a session in Run and Debug: what it says in the Debug Console, a Stop button, and it goes when the server does", async ({ page }) => {
	const workbench = await openEditor(page, files);
	const toolbar = (name) => workbench.locator(`.debug-toolbar .action-label[aria-label^='${name}']`);
	const said = (text) => workbench.locator(".repl .monaco-list-row", { "hasText": text }).first();

	await openFile(workbench, "sessionapp/src/main.ts");

	const { input } = await openTerminal(workbench);

	await input.pressSequentially("cd sessionapp && vite\n");
	await expect(previewWindows(page).frameLocator("iframe").locator("#app")).toHaveText("served", { "timeout": 90_000 });

	await stopShown(workbench, toolbar);
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
	await stopShown(workbench, toolbar);
	await previewWindows(page).locator(".app-window-controls [title='Close'], .app-window-controls [aria-label='Close']").click();
	await expect(toolbar("Stop")).toBeHidden({ "timeout": 30_000 });
});
