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
