/**
 * The preview windows (shell/preview-windows.tsx): `vite` opens one onto its server, its page runs, a save reaches the page,
 * another window can be opened, and closing them stops the server, as stopping the server closes them.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/preview-windows.mjs
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startSession } from "./architecture-harness.mjs";

let session;

before(async () => {
	session = await startSession();
});

after(async () => {
	await session?.close("preview-windows");
});

const output = async () => (await session.request("terminal.state", { "lines": 60 }, 10_000)).map((each) => each.output).join("\n");
const said = async (what, pattern) => session.eventually(what, async () => pattern.exec(await output()) ?? undefined, 90_000);
const windows = async () => session.page.locator("app-window[data-preview-port]").count();
/** What each window's page says. */
const pages = async () => session.page.evaluate(() => [...document.querySelectorAll("app-window[data-preview-port] iframe")].map((frame) => frame.contentDocument?.querySelector("#app")?.textContent ?? ""));
const app = (text) => `const said: string = ${JSON.stringify(text)};\n\ndocument.querySelector("#app")!.textContent = said;\n`;

test("vite opens a window: its page runs, a save reaches it, another opens, and the last one closing stops the server", async () => {
	await session.request("files.write", { "path": "winapp/index.html", "content": "<!doctype html><html><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.ts\"></script></body></html>\n" }, 30_000);
	await session.request("files.write", { "path": "winapp/src/main.ts", "content": app("first") }, 30_000);
	await session.terminal("cd winapp && vite", { "fresh": true });

	await session.eventually("a window, its page running", async () => ((await pages()).join() === "first" ? true : undefined), 90_000);

	const shown = session.page.locator("app-window[data-preview-port]");

	assert.equal(await shown.getAttribute("label"), "Preview :5173");
	assert.ok((await shown.locator("iframe").boundingBox()).height > 100, "the page has room");

	// A save reaches the page, without anything else asking.
	await session.request("files.write", { "path": "winapp/src/main.ts", "content": app("saved") }, 30_000);
	await session.eventually("the save in its page", async () => ((await pages()).join() === "saved" ? true : undefined), 60_000);

	// Another window onto the same server, not over the first.
	await session.page.locator("app-window[data-preview-port] [title='Another window onto this server']").click();
	await session.eventually("a second page running", async () => ((await pages()).join() === "saved,saved" ? true : undefined), 60_000);

	const [one, two] = await Promise.all([shown.nth(0).boundingBox(), shown.nth(1).boundingBox()]);

	assert.notDeepEqual([one.x, one.y], [two.x, two.y]);

	// A save reaches both.
	await session.request("files.write", { "path": "winapp/src/main.ts", "content": app("both") }, 30_000);
	await session.eventually("the save in both", async () => ((await pages()).join() === "both,both" ? true : undefined), 60_000);

	// Closing one keeps the server, and the other; closing the last stops it.
	const close = () => shown.first().locator(".app-window-controls [title='Close'], .app-window-controls [aria-label='Close']").first().click();

	await close();
	assert.equal(await windows(), 1);
	assert.doesNotMatch(await output(), /vite: dev server stopped/u);

	await close();
	await said("the server stopped", /vite: dev server stopped/u);
	assert.equal(await windows(), 0);
});

test("a server stopped elsewhere closes its windows", async () => {
	await session.request("files.write", { "path": "winapp2/index.html", "content": "<!doctype html><html><body><div id=\"app\">here</div></body></html>\n" }, 30_000);
	await session.terminal("cd winapp2 && vite", { "fresh": true });
	await session.eventually("its window", async () => ((await windows()) === 1 ? true : undefined), 90_000);
	await session.terminal("ps", { "fresh": true });

	const run = (await said("its run", /^\s*(\S+)\s+running\s+service\s+\d+/mu))[1];

	await session.terminal(`kill ${run}`);
	await session.eventually("no window", async () => ((await windows()) === 0 ? true : undefined), 30_000);
});
