/**
 * Rules, as a person has them: a capability call says how it's decided, on the call, and its lightbulb changes that; the whole
 * list is the policy file, each rule's sentence above it. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, problems, runCommand } from "./editor.mjs";

const PROGRAM = `import { execSync } from "node:child_process";

execSync("ls");
`;

test("a call says how it's decided, and its lightbulb decides it: denied it's an error, allowed it's quiet, and taking the rule out asks again", async ({ page }) => {
	const workbench = await openEditor(page, { "calls.mjs": PROGRAM });

	await openFile(workbench, "calls.mjs");

	const rows = await problems(workbench);
	const call = rows.filter({ "hasText": "exec: execSync → ls" });
	const fix = async (title) => {
		// (a problem opened puts the cursor on its call, and Quick Fix asks about what's there. It takes a moment to get there,
		// and the palette has no Quick Fix until the code has the focus)
		await call.dblclick();
		await expect(workbench.locator(".statusbar-item", { "hasText": "Ln 3" })).toBeVisible({ "timeout": 30_000 });
		await expect(codeOf(workbench)).toBeFocused({ "timeout": 30_000 });
		await runCommand(workbench, "Quick Fix...");
		await workbench.locator(".action-widget .monaco-list-row", { "hasText": title }).click();
	};

	await expect(call.filter({ "hasText": "Undecided: a run stops here and asks" })).toHaveCount(1, { "timeout": 90_000 });

	await fix("Deny exec on ls, always");
	await expect(call.filter({ "hasText": "Denied by your rule: capability is exec and resource is ls" })).toHaveCount(1, { "timeout": 30_000 });
	await expect(call.locator(".codicon-error")).toHaveCount(1);

	// The whole list is the file, each rule's sentence above it.
	await runCommand(workbench, "Capabilities: Open Rules");
	await expect(workbench.locator(".codelens-decoration", { "hasText": "capability is exec and resource is ls → deny" })).toBeVisible({ "timeout": 30_000 });
	await openFile(workbench, "calls.mjs");

	await fix("Take out your rule");
	await expect(call.filter({ "hasText": "Undecided" })).toHaveCount(1, { "timeout": 30_000 });

	await fix("Allow exec on ls, always");
	await expect(call).toHaveCount(0, { "timeout": 30_000 });
});
