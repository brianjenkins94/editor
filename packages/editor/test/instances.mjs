/**
 * Instances of the editor (shared/instance.ts, `?instance=<name>`): side by side on one origin, each with its own workspace;
 * a reset of one leaving the other and the service worker alone; and one in a frame, the top of itself, with its shell.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/instances.mjs
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startSession } from "./architecture-harness.mjs";

let session;
let other;

before(async () => {
	session = await startSession();
	other = await session.page.context().newPage();
});

after(async () => {
	await other?.close().catch(() => undefined);
	await session?.close("instances");
});

const address = (query) => new URL(`?${query}`, session.page.url()).href;
const workbenchOf = (page) => page.frames().find((frame) => frame.url().includes("/__vscode__/host.html"));

/** Once `page`'s workbench answers: asking it over its hub. */
async function ready(page) {
	await session.eventually("its workbench", async () => (await workbenchOf(page)?.evaluate(() => globalThis.__architecture !== undefined && globalThis.__editor?.api !== undefined).catch(() => false)) === true || undefined, 120_000);
}

const write = async (page, path, content) => workbenchOf(page).evaluate(([file, text]) => globalThis.__architecture.request("files.write", { "path": file, "content": text }, 30_000), [path, content]);
const exists = async (page, path) => workbenchOf(page).evaluate(async (file) => {
	const { api } = globalThis.__editor;

	return api.workspace.fs.stat(api.Uri.file(`/workspace/${file}`)).then(() => true, () => false);
}, path);
/** What's kept reaching IndexedDB: a write is debounced. */
const settled = async (page) => page.waitForTimeout(3000);

test("two editors on one origin: neither sees the other's files, and each keeps its own", async () => {
	await write(session.page, "only-real.txt", "real");
	await other.goto(address("instance=one"));
	await ready(other);

	assert.equal(await exists(other, "only-real.txt"), false, "the instance can't see the real workspace");

	await write(other, "only-instance.txt", "instance");
	assert.equal(await exists(other, "only-instance.txt"), true);
	assert.equal(await exists(session.page, "only-instance.txt"), false, "the real workspace can't see the instance's");

	const databases = await session.page.evaluate(async () => (await indexedDB.databases()).map(({ name }) => name));

	assert.ok(databases.includes("workspace-fs"));
	assert.ok(databases.includes("instance:one:workspace-fs"));
	assert.ok(databases.some((name) => name.startsWith("instance:one:vscode-web-")), "VS Code's own too, whose names it chooses");

	// Kept: it's a workspace, not a scratch space.
	await settled(other);
	await other.reload();
	await ready(other);
	assert.equal(await exists(other, "only-instance.txt"), true);
	assert.equal(await exists(other, "only-real.txt"), false);
});

test("an instance's reset is only its own: the real editor's workspace and the service worker stay", async () => {
	await settled(session.page);
	await other.goto(address("instance=one&reset"));
	await other.waitForURL((url) => !url.search.includes("reset"), { "timeout": 60_000 });
	await ready(other);

	assert.equal(await exists(other, "only-instance.txt"), false, "its own, gone");
	assert.equal(await exists(session.page, "only-real.txt"), true, "the real one's, there");
	assert.equal(await session.page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length), 1, "the service worker, there");

	// Not told to let go: the real editor is still the same page.
	await session.page.waitForTimeout(1000);
	assert.doesNotMatch(session.page.url(), /reset/u);
	assert.equal(await exists(session.page, "only-real.txt"), true);
});

test("an instance in a frame is the top of itself: its shell, its own workspace", async () => {
	await other.close();
	other = undefined;

	await session.page.evaluate((url) => {
		const frame = document.createElement("iframe");

		frame.dataset.instance = "";
		frame.allow = "cross-origin-isolated";
		frame.src = url;
		document.body.append(frame);
	}, address("instance=framed"));

	const inner = () => session.page.frames().find((frame) => frame.url().includes("instance=framed"));
	const workbench = () => session.page.frames().filter((frame) => frame.url().includes("/__vscode__/host.html")).find((frame) => frame.parentFrame()?.parentFrame() === inner());

	await session.eventually("its shell's Reset", async () => (await inner()?.locator("[title='Reset the editor']").count().catch(() => 0)) === 1 || undefined, 120_000);
	await session.eventually("its workbench", async () => (await workbench()?.evaluate(() => globalThis.__editor?.api !== undefined).catch(() => false)) === true || undefined, 120_000);

	const seen = await workbench().evaluate(async () => {
		const { api } = globalThis.__editor;

		return api.workspace.fs.stat(api.Uri.file("/workspace/only-real.txt")).then(() => true, () => false);
	});

	assert.equal(seen, false, "nor can it see the real workspace from inside it");
	assert.ok((await session.page.evaluate(async () => (await indexedDB.databases()).map(({ name }) => name))).includes("instance:framed:workspace-fs"));
});
