/**
 * A file moved, as a person moves it: renamed in the Explorer, its imports follow, as TypeScript works them out, with nothing
 * asked (workbench/code-refactor.ts). Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, openFile } from "./editor.mjs";

const files = {
	"tsconfig.json": "{ \"compilerOptions\": { \"allowJs\": true, \"checkJs\": false, \"module\": \"esnext\", \"target\": \"esnext\" }, \"include\": [\"**/*\"] }\n",
	"rate.mjs": "export const rate = 2;\n",
	"total.mjs": "import { rate } from \"./rate.mjs\";\n\nexport const total = rate * 10;\n"
};

/** What the Explorer and the window show: its rows, any text being typed into, what's said, the tabs. */
async function shown(workbench) {
	const texts = async (locator, most = 12) => {
		const found = [];

		for (let index = 0; index < Math.min(await locator.count(), most); index += 1) {
			found.push(await locator.nth(index).textContent());
		}

		return found;
	};

	return {
		"rows": await texts(workbench.getByRole("treeitem")),
		"typing": await texts(workbench.locator(".monaco-inputbox input")),
		"said": await texts(workbench.locator(".notification-list-item-message, .dialog-message-text, .monaco-inputbox-message"), 6),
		"tabs": await texts(workbench.locator(".tab"))
	};
}

test("a file renamed in the Explorer: what imports it follows, and nothing's asked", async ({ page }) => {
	const workbench = await openEditor(page, files);

	await openFile(workbench, "total.mjs");

	const row = workbench.getByRole("treeitem", { "name": "rate.mjs", "exact": true });

	// (selected in the Explorer, then its list focused again: a click on a file also opens it, which takes the focus)
	await row.click();
	await expect(workbench.locator(".tab.active", { "hasText": "rate.mjs" })).toBeVisible({ "timeout": 30_000 });

	const list = workbench.locator(".explorer-folders-view .monaco-list").first();
	const input = workbench.locator(".monaco-list-row .monaco-inputbox input").first();

	// Rename's key: F2, or Enter on a Mac (where F2 does nothing in the Explorer; elsewhere Enter opens the file, taking the focus).
	await list.focus();
	await list.press("F2");

	try {
		await expect(input).toBeVisible({ "timeout": 3000 });
	} catch {
		await list.focus();
		await list.press("Enter");
		await expect(input).toBeVisible({ "timeout": 15_000 });
	}

	await input.fill("prices.mjs");
	await input.press("Enter");

	try {
		// (a rename waits on TypeScript for its imports, which on a workspace just opened may still be starting)
		await expect(workbench.getByRole("treeitem", { "name": "prices.mjs", "exact": true })).toBeVisible({ "timeout": 90_000 });
	} catch (error) {
		// (it's failed on CI and not here: what the Explorer shows then, to say why)
		throw new Error(`${String(error)}; the Explorer: ${JSON.stringify(await shown(workbench))}`, { "cause": error });
	}

	await workbench.locator(".tab", { "hasText": "total.mjs" }).first().click();
	await expect(workbench.locator(".editor-instance .view-lines").first()).toContainText("./prices.mjs", { "timeout": 60_000 });
	await expect(workbench.locator(".dialog-box")).toHaveCount(0);
});
