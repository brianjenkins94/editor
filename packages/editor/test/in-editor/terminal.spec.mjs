/**
 * The workspace's terminal, as a person has it: a new one from the palette, commands typed at its prompt, on the workspace's
 * files, and what they make in the Explorer. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { openEditor, openTerminal, READABLE_TERMINAL } from "./editor.mjs";

test("a command typed at the prompt runs on the workspace's files, and what it says shows", async ({ page }) => {
	const workbench = await openEditor(page, { ...READABLE_TERMINAL, "hello.txt": "hello from the file\n" });
	const { input, output } = await openTerminal(workbench);

	await input.pressSequentially("echo a.b-c_1 && cat hello.txt\n");
	await expect(output).toContainText("hello from the file", { "timeout": 15_000 });
	await expect(output).toContainText("a.b-c_1");
});

test("a file the shell makes shows in the Explorer", async ({ page }) => {
	const workbench = await openEditor(page, { ...READABLE_TERMINAL, "hello.txt": "hello from the file\n" });
	const { input } = await openTerminal(workbench);

	await input.pressSequentially("echo made > made.txt\n");
	await expect(workbench.getByRole("treeitem", { "name": "made.txt", "exact": true })).toBeVisible({ "timeout": 15_000 });
});
