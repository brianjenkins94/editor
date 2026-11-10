/**
 * TypeScript Playground links (shell/playground.tsx, shared/playground-link.ts), as a person has them: a link opens its
 * project as the workspace, the top bar's Share writes the workspace as a link, and that link opens the same project.
 * Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

/** An editor of its own, opened at a playground link's hash: its workbench, once a file is listed. */
async function openLink(page, hash) {
	await page.goto(`?instance=test-${crypto.randomUUID()}${hash}`);

	const workbench = page.frameLocator("iframe[title='editor']").frameLocator("iframe");

	await expect(workbench.getByRole("treeitem").first()).toBeVisible({ "timeout": 120_000 });

	return workbench;
}

test("a playground link opens as the workspace, and Share makes one that opens the same project", async ({ page }) => {
	// (the classic playground's plainest link: one file's source; it's named as the playground names it, with its tsconfig)
	const workbench = await openLink(page, `#src=${encodeURIComponent("export const greet = (name: string) => \"Hello, \" + name;\n")}`);

	await expect(workbench.locator(".tab.active")).toContainText("input.tsx", { "timeout": 60_000 });
	await expect(workbench.getByRole("treeitem", { "name": "tsconfig.json" })).toHaveCount(1);
	// (the starter's files are gone, and the link has left the address: a reload keeps what's changed since)
	await expect(workbench.getByRole("treeitem", { "name": "src" })).toHaveCount(0);
	expect(new URL(await page.url()).hash).toBe("");

	// Share: the workspace as a Playground v2 link, on the site's root.
	await page.locator("wa-button[aria-label='Share']").click();

	const link = page.locator("wa-input[aria-label='Share link'] input");

	await expect(link).toHaveValue(/#code\/v2\//u, { "timeout": 30_000 });

	// …which opens the same project.
	const again = await openLink(page, new URL(await link.inputValue()).hash);

	await expect(again.locator(".tab.active")).toContainText("input.tsx", { "timeout": 60_000 });
	await expect(again.locator(".editor-instance .view-lines").first()).toContainText("\"Hello, \" + name");
});
