/**
 * The workspace's git as a person reviews and commits it, in a real editor: the shell's review panel (shell/git-panel.tsx)
 * — the changed files listed, some picked, committed with a message, one discarded — and VS Code's Source Control view
 * (extensions/source-control/) — a change listed, committed from its input box. Each over the workbench's git
 * (git-service.ts, git-review.ts); what was committed read back with `git.log` and `git.status`.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/git-views.mjs
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startSession } from "./architecture-harness.mjs";

let session;

before(async () => {
	session = await startSession();
});

after(async () => {
	await session?.close("git-views");
});

/** The paths `git.status` says have changed. */
const changed = async () => (await session.request("git.status", { "whole": true }, 60_000)).files.map((file) => file.path);

/** The latest commit's message. */
const lastCommit = async () => (await session.request("git.log", { "limit": 1 }, 30_000)).commits[0]?.message;

test("the review panel: changes listed, the picked one committed with the message, another discarded", async () => {
	const { page } = session;

	await session.request("files.write", { "path": "review-a.txt", "content": "a\n" }, 30_000);
	await session.request("files.write", { "path": "review-b.txt", "content": "b\n" }, 30_000);

	// (the panel's collapsed until it's asked for)
	if (!await page.locator(".gp").isVisible()) {
		await page.locator("wa-button[aria-label='Toggle changes panel']").click();
	}

	const row = (name) => page.locator(".gp-file", { "hasText": name });

	await session.eventually("both files listed", async () => (await row("review-a.txt").isVisible() && await row("review-b.txt").isVisible() ? true : undefined), 60_000);

	// Only review-a.txt picked: everything off, then it on.
	const all = page.locator("wa-checkbox[aria-label='Select all changes']");

	if (await all.evaluate((box) => box.checked || box.indeterminate)) {
		await all.click();
	}

	await row("review-a.txt").locator("wa-checkbox").click();
	await page.locator(".gp-commit wa-textarea textarea").fill("from the review panel");
	await page.locator(".gp-commit wa-button").click();

	await session.eventually("the commit made", async () => (await lastCommit() === "from the review panel" ? true : undefined), 60_000);

	const after = await changed();

	assert.equal(after.includes("review-a.txt"), false, "review-a.txt committed");
	assert.equal(after.includes("review-b.txt"), true, "review-b.txt left out");

	// Discard shows on the row under the pointer, and asks once more before it does (the button arms, then fires).
	await session.eventually("review-a.txt gone from the list", async () => (await row("review-a.txt").count() === 0 ? true : undefined), 30_000);
	await row("review-b.txt").hover();
	await row("review-b.txt").locator(".gp-discard").click();
	await row("review-b.txt").locator(".gp-discard").click();
	await session.eventually("review-b.txt discarded", async () => (!(await changed()).includes("review-b.txt") ? true : undefined), 30_000);
	await assert.rejects(session.request("files.read", { "path": "review-b.txt" }, 10_000), /doesn't exist/u);
});

test("Source Control: a change listed, committed from its input box", async () => {
	const { page } = session;
	const view = session.workbench();

	await session.request("files.write", { "path": "scm-a.txt", "content": "scm\n" }, 30_000);
	await session.execute("workbench.view.scm");

	const listed = view.locator(".scm-view .monaco-list-row", { "hasText": "scm-a.txt" });

	await session.eventually("scm-a.txt in the view", async () => (await listed.count() > 0 ? true : undefined), 60_000);

	await view.locator(".scm-editor .monaco-editor").first().click();
	await page.keyboard.type("from Source Control");
	await page.keyboard.press("ControlOrMeta+Enter");

	await session.eventually("the commit made", async () => (await lastCommit() === "from Source Control" ? true : undefined), 60_000);
	assert.equal((await changed()).includes("scm-a.txt"), false);
	await session.eventually("scm-a.txt gone from the view", async () => (await listed.count() === 0 ? true : undefined), 30_000);
});
