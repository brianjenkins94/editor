/**
 * The in-browser dev server (workers/node-worker.ts, the terminal's `vite`), as a person has it: a project served from the
 * terminal, its page running, a save reaching it, another refused, and stopping it. test/dev-server.mjs keeps what has no UI to
 * read. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { devApp, openEditor, openFile, openTerminal, previewWindows, retype } from "./editor.mjs";

test("vite serves a project: its page runs, a save reaches it, another is refused, and it stops", async ({ page }) => {
	const workbench = await openEditor(page, devApp("devapp", "from TypeScript"));

	await openFile(workbench, "devapp/src/main.ts");

	const first = await openTerminal(workbench);

	await first.input.pressSequentially("cd devapp && vite\n");
	await expect(first.output).toContainText(/Local:\s+\S+__virtual__\/\S+\/5173\//u, { "timeout": 90_000 });

	const app = page.frameLocator("app-window[data-preview-port] iframe").locator("#app");

	await expect(app).toHaveText("from TypeScript", { "timeout": 60_000 });

	// A save: the terminal says so, and the page has it.
	await retype(workbench, "document.querySelector(\"#app\")!.textContent = \"saved since\";");
	await expect(first.output).toContainText(/\[vite\] (?:hmr update|page reload)/u, { "timeout": 30_000 });
	await expect(app).toHaveText("saved since", { "timeout": 30_000 });

	// Another in the same folder is refused, and says where the first is.
	const second = await openTerminal(workbench);

	await second.input.pressSequentially("cd devapp && vite\n");
	await expect(second.output).toContainText("devapp is already being served on :5173", { "timeout": 30_000 });

	// Stopped, its window goes.
	await second.input.pressSequentially("ps\n");

	const row = second.output.locator("div", { "hasText": /running\s+service\s+5173/u });

	await expect(row).toBeVisible({ "timeout": 15_000 });

	const [run] = (await row.textContent()).trim().split(/\s+/u);

	await second.input.pressSequentially(`kill ${run}\n`);
	await expect(previewWindows(page)).toHaveCount(0, { "timeout": 30_000 });
});
