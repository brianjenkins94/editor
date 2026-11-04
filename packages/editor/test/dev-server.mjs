/**
 * What of the in-browser dev server a person doesn't see, and so in-editor/dev-server.spec.mjs can't read: the service worker's
 * answers. A page isolated like the rest of the editor, its TypeScript compiled, and nobody there once it stops, or on a port
 * nothing ever served. What a person has of it is that spec's.
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

test("what the service worker answers for a served project: isolated, compiled, and nobody there once it stops", async () => {
	await session.request("files.write", { "path": "devapp/index.html", "content": "<!doctype html><html><body><div id=\"app\"></div><script type=\"module\" src=\"/src/main.ts\"></script></body></html>\n" }, 30_000);
	await session.request("files.write", { "path": "devapp/src/main.ts", "content": "const said: string = \"from TypeScript\";\n\ndocument.querySelector(\"#app\")!.textContent = said;\n" }, 30_000);
	await session.terminal("cd devapp && vite", { "fresh": true });

	const address = (await said("its address", /Local:\s+(\S+__virtual__\/\S+)/u))[1];

	assert.match(address, /\/__virtual__\/[^/]+\/5173\/$/u);

	const page = await fetched(address);

	assert.equal(page.status, 200);
	assert.equal(page.isolated, true);
	assert.match(page.text, /src\/main\.ts/u);

	const module = await fetched(address + "src/main.ts");

	assert.equal(module.status, 200);
	assert.doesNotMatch(module.text, /: string/u);

	await session.terminal("ps", { "fresh": true });

	const run = (await said("its run", /^\s*(\S+)\s+running\s+service\s+5173/mu))[1];

	await session.terminal(`kill ${run}`);
	await session.eventually("nobody there", async () => ((await fetched(address)).status === 503 ? true : undefined), 30_000);
});

test("nobody on a port: said, not hung", async () => {
	const answer = await fetched(new URL("__virtual__/nobody/9/", session.page.url()).href);

	assert.notEqual(answer.status, 200);
});
