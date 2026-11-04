/**
 * The in-browser dev server (workers/node-worker.ts, the service worker's `/__virtual__/` route, the terminal's `vite`): a
 * project served in the browser, a real page of it running in a frame, a save reaching it, and stopping.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/dev-server.mjs
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { startSession } from "./architecture-harness.mjs";

let session;

before(async () => {
	session = await startSession();
});

after(async () => {
	await session?.close("dev-server");
});

const output = async () => (await session.request("terminal.state", { "lines": 60 }, 10_000)).map((each) => each.output).join("\n");

/** Waits for the terminal to say `pattern`; what matched. */
const said = async (what, pattern) => session.eventually(what, async () => pattern.exec(await output()) ?? undefined, 90_000);

/** `url`, fetched from the workbench's frame, so the service worker answers. */
const fetched = async (url) => session.workbench().evaluate(async (address) => {
	const response = await fetch(address);

	return { "status": response.status, "isolated": response.headers.get("cross-origin-embedder-policy") !== null, "text": await response.text() };
}, url);

test("vite serves a project in the browser: its page runs, a save reaches it, and it stops", async () => {
	await session.request("files.write", { "path": "devapp/index.html", "content": "<!doctype html><html><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.ts\"></script></body></html>\n" }, 30_000);
	await session.request("files.write", { "path": "devapp/src/main.ts", "content": "const said: string = \"from TypeScript\";\n\ndocument.querySelector(\"#app\")!.textContent = said;\n" }, 30_000);
	await session.terminal("cd devapp && vite", { "fresh": true });

	const address = (await said("its address", /Local:\s+(\S+__virtual__\/\S+)/u))[1];

	assert.match(address, /\/__virtual__\/[^/]+\/5173\/$/u);

	// Answered through the service worker, isolated like the rest of the editor, and its TypeScript compiled.
	const page = await fetched(address);

	assert.equal(page.status, 200);
	assert.equal(page.isolated, true);
	assert.match(page.text, /src\/main\.ts/u);

	const module = await fetched(address + "src/main.ts");

	assert.equal(module.status, 200);
	assert.doesNotMatch(module.text, /: string/u);

	// A real page of it, in a frame: its absolute import stays inside its server.
	const text = () => session.page.evaluate(() => document.querySelector("iframe[data-dev-server]")?.contentDocument?.querySelector("#app")?.textContent ?? "");

	await session.page.evaluate((url) => {
		const frame = document.createElement("iframe");

		frame.dataset.devServer = "";
		frame.src = url;
		document.body.append(frame);
	}, address);
	await session.eventually("the page ran", async () => ((await text()) === "from TypeScript" ? true : undefined), 60_000);

	// A save: the terminal says so, and the server answers with what was saved.
	await session.request("files.write", { "path": "devapp/src/main.ts", "content": "const said: string = \"saved since\";\n\ndocument.querySelector(\"#app\")!.textContent = said;\n" }, 30_000);
	await said("the update", /\[vite\] (?:hmr update|page reload)/u);
	await session.eventually("what was saved", async () => (/saved since/u.test((await fetched(address + "src/main.ts")).text) ? true : undefined), 30_000);

	// Another in the same folder is refused, and says where the first is.
	await session.terminal("cd devapp && vite", { "fresh": true });
	await said("the refusal", /devapp is already being served on :5173/u);

	// Stopped, its address says nobody's there.
	await session.terminal("ps");

	const run = (await said("its run", /^\s*(\S+)\s+running\s+service\s+5173/mu))[1];

	await session.terminal(`kill ${run}`);
	await said("it stopped", /vite: dev server stopped/u);
	await session.eventually("nobody there", async () => ((await fetched(address)).status === 503 ? true : undefined), 30_000);
});

test("nobody on a port: said, not hung", async () => {
	const answer = await fetched(new URL("__virtual__/nobody/9/", session.page.url()).href);

	assert.notEqual(answer.status, 200);
});
