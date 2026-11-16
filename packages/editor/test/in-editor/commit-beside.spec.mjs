/**
 * A commit beside the work (workbench/git-refs.ts), as a person opens one: "Git: Open a Commit Read-Only…", a branch named,
 * its files at `.refs/<name>/` as committed, read-only, and git not seeing them; or the code alone, its comments blanked line
 * for line and no docs. Runs in the editor: test/in-editor.mjs.
 */
import { expect, test } from "@playwright/test";

import { changesPanel, codeOf, commitAll, gitLog, openEditor, openFile, READABLE_TERMINAL, runCommand } from "./editor.mjs";

/** How many times "Open a Commit Read-Only" is asked, each a second longer after the last. */
const TRIES = 5;

/** "Git: Open a Commit Read-Only…" on `ref`, as it is or (`how`) the code alone. Its boxes close as their window loses the
 *  focus, as the palette's do (runCommand: another spec's editor in the same page), so it's asked again until both
 *  answers go to it — a while after each time, as the other spec typing keeps the focus for a while. */
async function openRef(page, workbench, ref, how = "As it is") {
	const input = workbench.locator(".quick-input-widget input[type='text'], .quick-input-widget input:not([type])").first();
	// (where each try stopped, said if none takes)
	const stopped = [];
	const answered = async (text, next, what) => {
		await input.fill(text);

		if (!await expect(input).toBeFocused({ "timeout": 1000 }).then(() => true, () => false)) {
			const focused = await workbench.locator(":focus").first().getAttribute("class").catch(() => "nothing");

			stopped.push(`${what}: not focused (${String(await input.count())} inputs; the focus on ${JSON.stringify(focused)}, ${await page.locator(":focus").first().getAttribute("class").catch(() => "nothing")} outside)`);

			return false;
		}

		await input.press("Enter");

		if (next !== undefined && !await expect(next).toBeVisible({ "timeout": 15_000 }).then(() => true, () => false)) {
			stopped.push(`${what}: no "${how}" after it (showing: ${JSON.stringify(await workbench.locator(".quick-input-widget").first().innerText().catch(() => "nothing"))})`);

			return false;
		}

		return true;
	};

	for (let tries = 1; tries <= TRIES; tries += 1) {
		await runCommand(workbench, "Git: Open a Commit Read-Only");

		// (its own box, not the palette's, before typing: the palette's goes as the command's comes)
		const box = workbench.locator(".quick-input-widget", { "hasText": "beside the work" });

		if (!await expect(box).toBeVisible({ "timeout": 15_000 }).then(() => true, () => false)) {
			stopped.push(`no box (showing: ${JSON.stringify(await workbench.locator(".quick-input-widget").first().innerText().catch(() => "nothing"))})`);
		} else if (await answered(ref, workbench.locator(".quick-input-list .monaco-list-row", { "hasText": how }).first(), "the ref") && await answered(how, undefined, "how")) {
			return;
		}

		await workbench.locator(".monaco-workbench").first().press("Escape");
		await page.waitForTimeout(tries * 1000);
	}

	throw new Error(`"Open a Commit Read-Only" on ${ref} (${how}) didn't take its answers in ${String(TRIES)} tries: ${stopped.join("; ")}`);
}

const code = (workbench) => workbench.locator(".editor-instance .view-lines").first();

test("a commit opened beside the work: its files as committed, read-only, and not git's", async ({ page }) => {
	const workbench = await openEditor(page, { ...READABLE_TERMINAL, "refs-probe/a.txt": "committed\n" });

	await commitAll(page, "refs: a file to read at its commit");

	// A name that isn't one says so.
	await openRef(page, workbench, "no-such-ref");
	await expect(workbench.locator(".notification-toast", { "hasText": "isn't a commit" })).toBeVisible({ "timeout": 60_000 });

	await openRef(page, workbench, "main");

	// The working file changed after: the commit's is as it was.
	await openFile(workbench, "refs-probe/a.txt");
	await codeOf(workbench).press("ControlOrMeta+a");
	await codeOf(workbench).pressSequentially("changed since\n");
	await codeOf(workbench).press("ControlOrMeta+s");
	await expect(workbench.locator(".tab.dirty")).toHaveCount(0, { "timeout": 30_000 });

	await openFile(workbench, ".refs/main/refs-probe/a.txt");
	await expect(code(workbench)).toHaveText("committed");

	// Typing there changes nothing: it's read-only.
	await codeOf(workbench).pressSequentially("no");
	await expect(code(workbench)).toHaveText("committed");
	await expect(workbench.locator(".tab.dirty")).toHaveCount(0);

	// Git doesn't see it: the working file's change is all there is.
	const { row } = await changesPanel(page);

	await expect(row("refs-probe/a.txt")).toBeVisible({ "timeout": 60_000 });
	await expect(page.locator(".gp-file", { "hasText": ".refs" })).toHaveCount(0);

	// (last: the palette gives the focus back to a terminal as it closes, and a command's box after it can go with it)
	await expect(await gitLog(workbench)).toContainText("refs: a file to read at its commit", { "timeout": 30_000 });
});

test("a commit's code alone: each file's comments blanked line for line, and no docs", async ({ page }) => {
	const workbench = await openEditor(page, { "refs-alone/a.ts": "/** what a is */\nexport const a = \"// kept\"; // why\n", "refs-alone/README.md": "# what it's for\n" });

	await commitAll(page, "refs: the code alone");
	await openRef(page, workbench, "main", "The code alone");
	await openFile(workbench, ".refs/main~stripped/refs-alone/a.ts");
	await expect(code(workbench)).toContainText("export const a = \"// kept\";", { "timeout": 110_000 });
	await expect(code(workbench)).not.toContainText("what a is");
	await expect(code(workbench)).not.toContainText("why");
	// (.refs, main~stripped, refs-alone, then its files: the fourth level is the commit's)
	await expect(workbench.locator("[role='treeitem'][aria-level='4'][aria-label='a.ts']")).toHaveCount(1);
	await expect(workbench.locator("[role='treeitem'][aria-level='4'][aria-label='README.md']")).toHaveCount(0);
});
