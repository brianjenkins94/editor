/**
 * Past runs (extensions/margin/values.ts, runs.ts), as a person has them: each run of a file is a ball at the top of the
 * Margin, coloured by how it ended. Picking one shows its values, a reformat run again is the same run counted, and they're
 * there after a reload. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { codeOf, openEditor, openFile, retype } from "./editor.mjs";

const files = { "runs.mjs": "const total = 1 + 1;\n" };

test("each run a ball: picked, it shows its values and how it ended; alike, it's counted; kept across a reload", async ({ page }) => {
	const workbench = await openEditor(page, files);
	const balls = workbench.locator(".notes-margin-run");
	const total = workbench.locator(".live-values-row", { "hasText": "total =" });
	const run = async (expected) => {
		await codeOf(workbench).press("F5");
		await expect(balls).toHaveCount(expected, { "timeout": 60_000 });
	};

	await openFile(workbench, "runs.mjs");
	await run(1);
	await expect(total).toContainText("2", { "timeout": 30_000 });
	await expect(balls.first()).toHaveClass(/ran/u, { "timeout": 30_000 });

	// Another run, of more code: a second ball, and its values shown.
	const more = workbench.locator(".live-values-row", { "hasText": "more =" });

	await retype(workbench, "const total = 1 + 1;\nconst more = 2 + 2;\n");
	await run(2);
	await expect(more).toContainText("4", { "timeout": 30_000 });

	// The first picked: what it computed then, and nothing it didn't. The latest again, all of it.
	await balls.first().click();
	await expect(more).toHaveCount(0, { "timeout": 15_000 });
	await expect(total).toContainText("2", { "timeout": 15_000 });
	await balls.last().click();
	await expect(more).toContainText("4", { "timeout": 15_000 });

	// The same code run again, reformatted: the same ball, counted.
	await retype(workbench, "const total  =  1 + 1;\nconst more  =  2 + 2;\n");
	await codeOf(workbench).press("F5");
	await expect(balls.last()).toHaveAttribute("title", /2 runs alike/u, { "timeout": 60_000 });
	await expect(balls).toHaveCount(2);

	// One that throws is coloured so, and picking it marks where.
	await retype(workbench, "const total = 1 + 1;\nthrow new Error(\"no more\");\n");
	await run(3);
	await expect(balls.last()).toHaveClass(/crashed/u, { "timeout": 30_000 });
	await expect(workbench.locator(".notes-margin-mark.run-crashed")).toHaveAttribute("title", /no more/u, { "timeout": 15_000 });
	await balls.first().click();
	await expect(workbench.locator(".notes-margin-mark.run-crashed")).toHaveCount(0, { "timeout": 15_000 });

	// They're kept on this machine: after a reload, all of them, the latest shown (an older one's shown now, so it's not
	// what was here before).
	await expect(balls.first()).toHaveAttribute("aria-pressed", "true", { "timeout": 15_000 });
	await page.goto(`${await page.url()}&again`);
	await expect(workbench.getByRole("treeitem").first()).toBeVisible({ "timeout": 120_000 });
	await openFile(workbench, "runs.mjs");
	await expect(balls.last()).toHaveAttribute("aria-pressed", "true", { "timeout": 90_000 });
	await expect(balls).toHaveCount(3);
	await balls.first().click();
	await expect(total).toContainText("2", { "timeout": 15_000 });
});
