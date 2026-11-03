/**
 * The workspace's git as a person reviews and commits it, in a real editor: the shell's review panel (shell/git-panel.tsx)
 * — the changed files listed, some picked, committed with a message, one discarded — and VS Code's Source Control view
 * (extensions/source-control/) — a change listed, committed from its input box — and a change's problems on its row in
 * the panel (shell/change-problems.tsx, workbench/code-problems.ts). Each over the workbench's git
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

test("a change's problems: what it made and what it fixed against HEAD, from code.problems and on its row in the panel", async () => {
	const { page } = session;
	const shown = async (path, content) => {
		await session.request("files.write", { "path": path, "content": content }, 30_000);
		await session.workbench().evaluate(async (file) => {
			const { api } = globalThis.__editor;

			await api.window.showTextDocument(api.Uri.file("/workspace/" + file));
		}, path);
	};

	await shown("problems/a.ts", "export const fine: number = 1;\nexport const broken: number = \"no\";\n");
	await session.request("git.commit", { "message": "problems: at HEAD", "files": [{ "path": "problems/a.ts" }] }, 60_000);
	// (one fixed, a different one made: a problem is the same one when its file, source, code and message are)
	await shown("problems/a.ts", "export const fine: boolean = 1;\nexport const broken: number = 2;\n");

	const compared = await session.eventually("the change's problems", async () => {
		const answer = await session.request("code.problems", { "paths": ["problems"] }, 120_000);

		return answer.counts.added > 0 && answer.counts.cleared > 0 ? answer : undefined;
	}, 120_000);

	// (TypeScript's, exactly: the preset's ESLint has its say too — HEAD's `fine: number = 1` was ts/no-inferrable-types)
	const typescript = (problems) => problems.filter(({ source }) => source === "ts").map(({ line, code }) => [line, code]);

	assert.deepEqual(typescript(compared.added), [[1, 2322]]);
	assert.deepEqual(typescript(compared.cleared), [[2, 2322]], "as HEAD had it");

	if (!await page.locator(".gp").isVisible()) {
		await page.locator("wa-button[aria-label='Toggle changes panel']").click();
	}

	const row = page.locator(".gp-file", { "hasText": "problems/a.ts" });

	const added = row.locator(`wa-badge[aria-label='${String(compared.counts.added)} new problems']`);
	const cleared = row.locator(`wa-badge[aria-label='${String(compared.counts.cleared)} problems fixed']`);

	await session.eventually("its row's counts", async () => (await added.count() > 0 && await cleared.count() > 0 ? true : undefined), 120_000);
	assert.match(await added.getAttribute("title"), /1: Type 'number' is not assignable to type 'boolean'\. \(ts 2322\)/u);
	assert.match(await cleared.getAttribute("title"), /2: Type 'string' is not assignable to type 'number'\. \(ts 2322\)/u);
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
