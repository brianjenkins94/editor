/**
 * Explore Orderings (extensions/tsval/explore.ts, worker/explore.ts), as a person has it: the menu above a code file (More Actions) runs
 * it under every ordering of its events, what depends on the order is said on the line it's about, and its lightbulb
 * debugs one of them, run exactly that way. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, problems, quickFix, runCommand } from "./editor.mjs";

/** Two fetches race a timer: which answer is in when it fires is up to the order the results come in. */
const RACE = [
	"let last;",
	"fetch(\"https://a.example/\").then(() => { last = \"won by a\"; });",
	"fetch(\"https://b.example/\").then(() => { last = \"won by b\"; });",
	"setTimeout(() => console.log(last ?? \"nobody yet\"), 10);",
	""
].join("\n");

/** The network allowed, so the debugged ordering doesn't stop at its fetches to ask. */
const ALLOW_NET = {
	"when": {
		"logicalType_id": "all",
		"predicates": [
			{ "target_id": "capability", "operator_id": "is", "argument": "net" }
		]
	},
	"then": [
		{ "action_id": "allow" }
	]
};

test("a race's endings, said on the line that differs, and one of them debugged from its lightbulb", async ({ page }) => {
	const workbench = await openEditor(page, {
		"race.mjs": RACE,
		".silo/policy.json": `${JSON.stringify({
			"version": 1,
			"rules": [ALLOW_NET]
		}, undefined, 2)}\n`
	});

	await openFile(workbench, "race.mjs");
	await runCommand(workbench, "Debug: Explore Orderings");

	// The line whose output depends on the order, with each way it goes.
	const rows = await problems(workbench);
	const raced = rows.filter({ "hasText": "What this line does depends on the order of events" });

	await expect(raced).toHaveCount(1, { "timeout": 120_000 });

	for (const said of ["prints \"won by a\"", "prints \"won by b\"", "prints \"nobody yet\""]) {
		await expect(raced).toContainText(said);
	}

	// Its lightbulb: the ordering in which a wins, debugged; that's what it prints.
	await openFile(workbench, "race.mjs");
	await codeOf(workbench).press("Control+g");

	const go = workbench.locator(".quick-input-widget input").first();

	await go.fill(":4:1");
	await go.press("Enter");
	await quickFix(workbench, "where it prints \"won by a\"");
	await workbench.locator(".panel .action-label", { "hasText": "Debug Console" }).first().click();
	await expect(workbench.locator(".repl .output", { "hasText": "won by a" }).first()).toBeVisible({ "timeout": 60_000 });
	await expect(workbench.locator(".repl .output", { "hasText": "won by b" })).toHaveCount(0);

	// An edit to the file takes what was said away: it may no longer be so.
	await codeOf(workbench).press("End");
	await codeOf(workbench).pressSequentially(" ");
	await problems(workbench);
	await expect(raced).toHaveCount(0, { "timeout": 30_000 });
});
