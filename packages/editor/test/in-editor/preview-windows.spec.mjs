/**
 * The preview windows (shell/preview-windows.tsx), as a person has them: `vite` opens one onto its server, its page runs, a
 * save reaches it, another can be opened, and closing them stops the server, as stopping the server closes them. Runs in the
 * editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { devApp, openEditor, openFile, openTerminal, previewWindows, retype } from "./editor.mjs";

const said = (text) => `document.querySelector("#app")!.textContent = "${text}";`;

test("vite opens a window: its page runs, a save reaches it, another opens, and the last one closing stops the server", async ({ page }) => {
	const workbench = await openEditor(page, devApp("winapp", "first"));

	await openFile(workbench, "winapp/src/main.ts");

	const { input, output } = await openTerminal(workbench);

	await input.pressSequentially("cd winapp && vite\n");

	const shown = previewWindows(page);
	const pageOf = (at) => shown.nth(at).frameLocator("iframe").locator("#app");

	await expect(pageOf(0)).toHaveText("first", { "timeout": 90_000 });
	await expect(shown).toHaveAttribute("label", "Preview :5173");
	expect((await shown.locator("iframe").boundingBox()).height).toBeGreaterThan(100);

	// A save reaches the page, without anything else asking.
	await retype(workbench, said("saved"));
	await expect(pageOf(0)).toHaveText("saved", { "timeout": 60_000 });

	// Another window onto the same server, not over the first.
	await shown.locator("[title='Another window onto this server']").click();
	await expect(pageOf(1)).toHaveText("saved", { "timeout": 60_000 });

	const [one, two] = [await shown.nth(0).boundingBox(), await shown.nth(1).boundingBox()];

	expect([one.x, one.y]).not.toEqual([two.x, two.y]);

	// A save reaches both.
	await retype(workbench, said("both"));
	await expect(pageOf(0)).toHaveText("both", { "timeout": 60_000 });
	await expect(pageOf(1)).toHaveText("both", { "timeout": 60_000 });

	// Closing one keeps the server, and the other; closing the last stops it.
	const close = shown.last().locator(".app-window-controls [title='Close'], .app-window-controls [aria-label='Close']").first();

	await close.click();
	await expect(shown).toHaveCount(1);
	await expect(output).not.toContainText("vite: dev server stopped");

	await close.click();
	await expect(shown).toHaveCount(0);
	await expect(output).toContainText("vite: dev server stopped", { "timeout": 30_000 });
});

test("a server stopped elsewhere closes its windows", async ({ page }) => {
	const workbench = await openEditor(page, devApp("winapp2", "here"));
	const first = await openTerminal(workbench);

	await first.input.pressSequentially("cd winapp2 && vite\n");
	await expect(previewWindows(page)).toHaveCount(1, { "timeout": 90_000 });

	const second = await openTerminal(workbench);

	await second.input.pressSequentially("ps\n");

	const row = second.output.locator("div", { "hasText": /running\s+service\s+\d+/u });

	await expect(row).toBeVisible({ "timeout": 15_000 });

	const [run] = (await row.textContent()).trim().split(/\s+/u);

	await second.input.pressSequentially(`kill ${run}\n`);
	await expect(previewWindows(page)).toHaveCount(0, { "timeout": 30_000 });
});
