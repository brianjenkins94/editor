/**
 * A package's own calls in a run (extensions/tsval/worker/package-calls.ts, decided by the editor through
 * extensions/bridge/capabilities/decide.ts): a dependency's code that writes a file is asked of the policy, as the
 * package it is, and the run is told how it went. Undecided, the call isn't made and the editor says why, once; a rule
 * that allows it lets it through. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, runCommand } from "./editor.mjs";

const files = {
	// (F5's runs only: no live runs)
	".vscode/settings.json": "{ \"run.liveRuns\": false }\n",
	"node_modules/writer/package.json": "{ \"name\": \"writer\", \"version\": \"1.0.0\", \"type\": \"module\", \"main\": \"index.js\" }\n",
	"node_modules/writer/index.js": "import * as fs from \"node:fs\";\n\nexport function save(text) {\n\ttry {\n\t\tfs.writeFileSync(\"/workspace/out.txt\", text);\n\n\t\treturn \"saved\";\n\t} catch (error) {\n\t\treturn error.code;\n\t}\n}\n",
	"main.mjs": "import { save } from \"writer\";\n\nconsole.log(\"writer: \" + save(\"one\") + \", then \" + save(\"two\"));\n"
};

const allowWrites = { "version": 1, "rules": [{ "when": { "logicalType_id": "all", "predicates": [{ "target_id": "capability", "operator_id": "is", "argument": "fs:write" }, { "target_id": "resource", "operator_id": "matches", "argument": "/workspace/*" }] }, "then": [{ "action_id": "allow" }] }] };

async function run(workbench) {
	await openFile(workbench, "main.mjs");
	await codeOf(workbench).press("F5");
	await runCommand(workbench, "Debug Console: Focus on Debug Console View");
}

test("a package's write no rule decides isn't made, and the editor says why, once", async ({ page }) => {
	const workbench = await openEditor(page, files);

	await run(workbench);

	// (the second call, in the same run, is refused as the first was, without asking again)
	await expect(workbench.locator(".repl .output", { "hasText": "writer: EACCES, then EACCES" }).first()).toBeVisible({ "timeout": 60_000 });
	await expect(workbench.locator(".notification-list-item-message", { "hasText": "writer@1.0.0's call to fs:write" })).toHaveCount(1);
	await expect(workbench.locator(".notification-list-item-message", { "hasText": "the policy doesn't decide it" }).first()).toBeVisible();
});

test("a rule that allows it lets the package's write through", async ({ page }) => {
	const workbench = await openEditor(page, { ...files, ".silo/policy.json": JSON.stringify(allowWrites, null, 2) + "\n" });

	await run(workbench);

	await expect(workbench.locator(".repl .output", { "hasText": "writer: saved, then saved" }).first()).toBeVisible({ "timeout": 60_000 });
});
