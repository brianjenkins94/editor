/**
 * A merge's conflicts, as a person settles them (git pull's when each has moved on: workbench/git-engine.ts `mergeWith`,
 * whose writing of them test/git-merge.test.mjs holds): a file with both sides marked shows VS Code's own actions above
 * them (the merge-conflict extension, components/monaco-vscode-api), and one of them settles it. Runs in the editor:
 * test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile } from "./editor.mjs";

test("a file with a merge's conflict marked: Accept Both Changes keeps mine, then theirs, and the markers go", async ({ page }) => {
	const workbench = await openEditor(page, { "a.txt": "one\n<<<<<<< main\ntwo, mine\n=======\ntwo, theirs\n>>>>>>> theirs\nthree\n" });

	await openFile(workbench, "a.txt");
	await workbench.getByText("Accept Both Changes").first().click({ "timeout": 60_000 });
	await expect(workbench.locator(".editor-instance .view-lines").first()).toContainText("onetwo, minetwo, theirsthree", { "timeout": 30_000 });
	await expect(workbench.getByText("Accept Current Change")).toHaveCount(0);
	await codeOf(workbench).press("ControlOrMeta+s");
});
