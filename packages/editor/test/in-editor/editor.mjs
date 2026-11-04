/**
 * What a test running in the editor uses to open one: an instance of its own, in a preview window (shared/instance.ts),
 * holding only the files it's given, and the way a person gets around it.
 */
import { expect } from "@playwright/test";

let instances = 0;

/** An editor of its own, holding `files` (each path from its workspace's root, with its text): its workbench, once it's up. */
export async function openEditor(page, files) {
	instances += 1;

	const seed = encodeURIComponent(Buffer.from(JSON.stringify(files)).toString("base64"));

	await page.goto(`?instance=test-${String(Date.now())}-${String(instances)}&seed=${seed}`);

	const workbench = page.frameLocator("iframe[title='editor']").frameLocator("iframe");

	await expect(workbench.getByRole("treeitem").first()).toBeVisible({ "timeout": 120_000 });

	return workbench;
}

/** A command, from the palette, as a person runs one. */
export async function runCommand(workbench, title) {
	await workbench.locator(".monaco-workbench").first().press("F1");

	const input = workbench.locator(".quick-input-widget input[type='text'], .quick-input-widget input:not([type])").first();

	await input.fill(`>${title}`);
	await workbench.locator(".quick-input-list .monaco-list-row", { "hasText": title }).first().click();
}

/** A file from the Explorer, by its path: each folder opened on the way, as a person goes. */
export async function openFile(workbench, path) {
	const parts = path.split("/");

	for (const [at, name] of parts.entries()) {
		const row = workbench.getByRole("treeitem", { "name": name, "exact": true });

		await expect(row).toBeVisible({ "timeout": 30_000 });

		if (at === parts.length - 1) {
			// (twice, to keep it: a click's tab is a preview, which the next file opened takes the place of)
			await row.dblclick();
		} else if (await row.getAttribute("aria-expanded") === "false") {
			await row.click();
		}
	}

	await expect(workbench.locator(".tab.active", { "hasText": parts.at(-1) })).toBeVisible({ "timeout": 30_000 });
}

/** The Problems panel, opened: its rows, each file's and each problem's. */
export async function problems(workbench) {
	await runCommand(workbench, "View: Focus Problems");
	await expect(workbench.locator(".markers-panel")).toBeVisible({ "timeout": 30_000 });

	return workbench.locator(".markers-panel .monaco-list-row");
}

/** Where a person's typing goes in the open file. */
export const codeOf = (workbench) => workbench.locator(".editor-instance .native-edit-context").first();
