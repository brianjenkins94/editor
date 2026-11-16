/**
 * A change's problems (shell/change-problems.tsx, workbench/code-problems.ts), as a person has them: on a changed file's row
 * in the changes panel, what the change made and what it fixed against the last commit, each said by its line and message.
 * Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { changesPanel, commitAll, openEditor, openFile, retype } from "./editor.mjs";

test("what a change made and what it fixed against the last commit, on its row in the changes panel", async ({ page }) => {
	const workbench = await openEditor(page, { "problems/a.ts": "export const fine: number = 1;\nexport const broken: number = \"no\";\n" });

	await commitAll(page, "problems: at HEAD");

	// One fixed, a different one made (a problem is the same one when its file, source, code and message are).
	await openFile(workbench, "problems/a.ts");
	await retype(workbench, "export const fine: boolean = 1;\nexport const broken: number = 2;\n");

	const { row } = await changesPanel(page);
	const added = row("problems/a.ts").locator("wa-badge[aria-label$=' new problems'], wa-badge[aria-label$=' new problem']");
	const cleared = row("problems/a.ts").locator("wa-badge[aria-label$=' problems fixed'], wa-badge[aria-label$=' problem fixed']");

	await expect(added).toHaveAttribute("title", /1: Type 'number' is not assignable to type 'boolean'\. \(ts 2322\)/u, { "timeout": 110_000 });
	await expect(cleared).toHaveAttribute("title", /2: Type 'string' is not assignable to type 'number'\. \(ts 2322\)/u, { "timeout": 60_000 });
});
