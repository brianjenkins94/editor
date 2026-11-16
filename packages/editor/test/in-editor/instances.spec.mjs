/**
 * Instances of the editor (shared/instance.ts, `?instance=<name>`), as a person has them: one in a window is the top of
 * itself, with its shell and a workspace of its own; two on one origin keep their files apart, and each what it changed,
 * across going away and back; and an instance's reset takes back only its own changes — the editor this test runs in, whose
 * workspace this program reads, untouched. Runs in the editor: test/in-editor.mjs.
 *
 * (What an instance starts with, `&seed=`, is where it starts each time, in place of the starter; what it keeps is what it
 * changed, written over that.)
 */
import { expect, test } from "@playwright/test";
import * as fs from "node:fs";

import { codeOf, openFile } from "./editor.mjs";

/** A name of this run's own, so a test's instance is new each time. */
const named = (what) => `${what}-${crypto.randomUUID().slice(0, 8)}`;

/** `files`, as `&seed=` takes them. */
const seeded = (files) => encodeURIComponent(Buffer.from(JSON.stringify(files)).toString("base64"));

/** The page gone to `query`, once its editor's Explorer shows something. */
async function goTo(page, query) {
	await page.goto(`?${query}`);

	const workbench = page.frameLocator("iframe[title='editor']").frameLocator("iframe");

	await expect(workbench.getByRole("treeitem").first()).toBeVisible({ "timeout": 110_000 });

	return workbench;
}

/** A file at the workspace's top, as the Explorer shows it. */
const shown = (workbench, name) => workbench.locator(`[role='treeitem'][aria-level='1'][aria-label='${name}']`);

/** The text of the file in front. */
const text = (workbench) => workbench.locator(".editor-instance .view-lines").first();

/** `path` changed to `content` and saved, as a person does, and given time to be kept (IndexedDB: a write is debounced). */
async function change(page, workbench, path, content) {
	await openFile(workbench, path);
	await codeOf(workbench).press("ControlOrMeta+a");
	await codeOf(workbench).pressSequentially(content);
	await codeOf(workbench).press("ControlOrMeta+s");
	await expect(workbench.locator(".tab.dirty")).toHaveCount(0, { "timeout": 30_000 });
	await page.waitForTimeout(3000);
}

test("an editor in a window is the top of itself: its shell, and a workspace of its own", async ({ page }) => {
	const workbench = await goTo(page, `instance=${named("top")}&seed=${seeded({ "only-here.txt": "here\n" })}`);

	await expect(page.locator("[title='Reset the editor']")).toHaveCount(1, { "timeout": 30_000 });
	await expect(shown(workbench, "only-here.txt")).toBeVisible();

	// Not the editor it's in: this test's own file is in that one's workspace, not this one's.
	expect(fs.existsSync(process.argv[1])).toBe(true);
	await expect(workbench.locator(`[role='treeitem'][aria-label='${process.argv[1].split("/").at(-1)}']`)).toHaveCount(0);
});

test("two editors on one origin: neither sees the other's files, and each keeps what it changed", async ({ page }) => {
	const one = `instance=${named("one")}&seed=${seeded({ "only-one.txt": "one\n" })}`;
	let workbench = await goTo(page, one);

	await change(page, workbench, "only-one.txt", "kept");

	workbench = await goTo(page, `instance=${named("two")}&seed=${seeded({ "only-two.txt": "two\n" })}`);
	await expect(shown(workbench, "only-two.txt")).toBeVisible();
	await expect(shown(workbench, "only-one.txt")).toHaveCount(0);

	// Back to the first: as it was left — a workspace, not a scratch space.
	workbench = await goTo(page, one);
	await expect(shown(workbench, "only-two.txt")).toHaveCount(0);
	await openFile(workbench, "only-one.txt");
	await expect(text(workbench)).toHaveText("kept", { "timeout": 30_000 });
});

test("an instance's reset is only its own: what it changed goes, and the editor it's in keeps its workspace", async ({ page }) => {
	const one = `instance=${named("reset")}&seed=${seeded({ "only-one.txt": "one\n" })}`;
	let workbench = await goTo(page, one);

	await change(page, workbench, "only-one.txt", "changed");

	workbench = await goTo(page, `${one}&reset`);
	await openFile(workbench, "only-one.txt");
	await expect(text(workbench)).toHaveText("one", { "timeout": 30_000 });

	// The editor this test runs in, still there: its workspace (this file in it), and this run going on.
	expect(fs.existsSync(process.argv[1])).toBe(true);
});
