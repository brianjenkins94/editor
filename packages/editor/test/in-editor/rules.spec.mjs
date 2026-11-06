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

test("a rule picked from the lightbulb covers what's picked: a stop's answered by the picker too, and a value given is what the call returns", async ({ page }) => {
	const workbench = await openEditor(page, { "calls.mjs": `import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";

console.log("said " + execSync("ls"));
writeFileSync("/workspace/out/kept.txt", "kept");
console.log("done");
fetch("https://example.com/a");
` });

	await openFile(workbench, "calls.mjs");

	const rows = await problems(workbench);
	const call = (text) => rows.filter({ "hasText": text });
	const picker = (text) => workbench.locator(".quick-input-list .monaco-list-row", { "hasText": text });
	const answer = (text) => workbench.locator(".notes-margin-cell .live-values-choice", { "hasText": text });

	// From the lightbulb: what it covers, then what happens.
	await expect(call("net: fetch")).toHaveCount(1, { "timeout": 90_000 });
	await call("net: fetch").dblclick();
	await expect(workbench.locator(".statusbar-item", { "hasText": "Ln 7" })).toBeVisible({ "timeout": 30_000 });
	await expect(codeOf(workbench)).toBeFocused({ "timeout": 30_000 });
	await runCommand(workbench, "Quick Fix...");
	await workbench.locator(".action-widget .monaco-list-row", { "hasText": "Make a rule" }).click();
	await picker("https://example.com/**").click();
	await picker("Skip").click();
	await expect(call("Skipped by your rule: capability is net and resource matches https://example.com/**")).toHaveCount(1, { "timeout": 30_000 });

	await codeOf(workbench).press("F5");

	// A value given at a stop is what that call returns.
	await answer("Give…").click({ "timeout": 60_000 });
	await workbench.locator(".quick-input-widget input").first().fill("hello");
	await workbench.locator(".quick-input-widget input").first().press("Enter");

	// A rule picked at a stop decides it, and is kept.
	await answer("Rule…").click({ "timeout": 60_000 });
	await picker("/workspace/**").click();
	await picker("Allow").click();

	await expect(workbench.getByRole("treeitem", { "name": "out", "exact": true })).toBeVisible({ "timeout": 60_000 });
	await expect(call("fs:write")).toHaveCount(0, { "timeout": 30_000 });

	await workbench.locator(".panel .action-label", { "hasText": "Debug Console" }).first().click();
	await expect(workbench.locator(".repl .output", { "hasText": "said hello" }).first()).toBeVisible({ "timeout": 30_000 });
});
