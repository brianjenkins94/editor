/* eslint-disable webawesome/no-html-in-strings -- the fixture app's own HTML files, written into the workspace for the dev server to serve; not editor chrome */
/**
 * An app shaped like the games the editor runs (netsim, war2): its dependency is a published TARBALL (a URL in
 * package.json, no registry), and it runs across a module WORKER that imports it and a nested IFRAME that talks to
 * that worker over a MessageChannel the page brokers. Written into the workspace, run with `vite` from the terminal,
 * checked in the preview: the frame asks the worker (over hub, from the tarball) and gets its answer.
 *
 *   node --test test/architecture-app.mjs      (see architecture-harness.mjs for the browser + dev server)
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { DEBUG_MCP_PORT, hasLabel, startSession } from "./architecture-harness.mjs";

const { createDebugMcp } = await import("../../debug-mcp/src/server.ts");

const HUB = "https://brianjenkins94.github.io/editor/packages/hub@latest.tgz";

const FILES = {
	"package.json": JSON.stringify({ "name": "wired", "private": true, "type": "module", "dependencies": { "@brianjenkins94/hub": HUB } }, null, "\t"),
	"index.html": "<!doctype html>\n<html><head><title>wired</title></head><body><script type=\"module\" src=\"./main.ts\"></script></body></html>\n",
	"frame.html": "<!doctype html>\n<html><head><title>wired frame</title></head><body><script type=\"module\" src=\"./frame.ts\"></script></body></html>\n",
	// The page: starts the worker, adds the frame, and hands each one end of a channel between them.
	"main.ts": [
		"import { createHub } from \"@brianjenkins94/hub\";",
		"",
		"const state: { \"hub\": string; \"results\": unknown[]; \"stray\": number; \"startedAt\": number } = { \"hub\": createHub({ \"id\": \"page\" }).id, \"results\": [], \"stray\": 0, \"startedAt\": performance.timeOrigin };",
		"const worker = new Worker(new URL(\"./worker.ts\", import.meta.url), { \"type\": \"module\" });",
		"const frame = document.createElement(\"iframe\");",
		"",
		"(globalThis as unknown as { \"__wired\": typeof state }).__wired = state;",
		"frame.src = \"frame.html\";",
		"frame.addEventListener(\"load\", () => {",
		"\tconst channel = new MessageChannel();",
		"",
		"\tworker.postMessage({ \"port\": channel.port1 }, [channel.port1]);",
		"\tframe.contentWindow!.postMessage({ \"port\": channel.port2 }, location.origin, [channel.port2]);",
		"}, { \"once\": true });",
		"addEventListener(\"message\", (event) => {",
		"\tif (event.source === frame.contentWindow && event.data?.wired !== undefined) {",
		"\t\tstate.results.push(event.data.wired);",
		"\t}",
		"",
		"\t// The editor's tap must report the frame's console to the editor, not to this page.",
		"\tif (event.data?.channel === \"obs-log\" || event.data?.channel === \"cap-decide\") {",
		"\t\tstate.stray += 1;",
		"\t}",
		"});",
		"document.body.append(frame);",
		""
	].join("\n"),
	// The worker: serves an RPC on its end of the channel.
	"worker.ts": [
		"import { createHub, portTransport, serve } from \"@brianjenkins94/hub\";",
		"",
		"addEventListener(\"message\", (event: MessageEvent) => {",
		"\tif (event.data?.port instanceof MessagePort) {",
		"\t\tconst hub = createHub({ \"id\": \"worker\" });",
		"",
		"\t\thub.link(portTransport(event.data.port));",
		"\t\tserve(hub, \"wired.echo\", (args) => ({ \"echoed\": args, \"from\": hub.id }));",
		"\t}",
		"});",
		""
	].join("\n"),
	// The frame: calls the worker over its end, and reports the answer to the page.
	"frame.ts": [
		"import { createHub, createRpcClient, portTransport } from \"@brianjenkins94/hub\";",
		"",
		"document.title = \"wired frame v1\";",
		"",
		"addEventListener(\"message\", async (event: MessageEvent) => {",
		"\tif (event.source === parent && event.data?.port instanceof MessagePort) {",
		"\t\tconst hub = createHub({ \"id\": \"frame\" });",
		"",
		"\t\thub.link(portTransport(event.data.port));",
		"",
		"\t\tconst answer = await createRpcClient(hub).request(\"wired.echo\", \"hi\", { \"timeoutMs\": 10_000, \"waitForResponderMs\": 10_000 });",
		"",
		"\t\tparent.postMessage({ \"wired\": answer }, location.origin);",
		"\t\tconsole.log(\"wired frame says hi\");",
		"\t}",
		"});",
		""
	].join("\n")
};

let session;
let debugMcp;

before(async () => {
	// Our own debug-mcp, in this process, so a test can read what reached it; the page's socket is relayed here.
	debugMcp = createDebugMcp({ "port": DEBUG_MCP_PORT });
	await debugMcp.whenListening;
	session = await startSession({ "debugMcp": "external" });
});
after(async () => {
	await session?.close("architecture-app");
	await debugMcp?.close();
});

async function eventually(what, probe, timeoutMs = 60_000) {
	const deadline = Date.now() + timeoutMs;

	for (;;) {
		const value = await probe().catch(() => undefined);

		if (value) {
			return value;
		}

		if (Date.now() > deadline) {
			throw new Error("timed out waiting for " + what);
		}

		await session.page.waitForTimeout(250);
	}
}

/** The frame the app nests in its page. */
function nestedFrame() {
	return previewPage()?.childFrames().find((frame) => frame.url().includes("frame.html"));
}

/** The preview's top page (not its nested frame). */
function previewPage() {
	return session.page.frames().find((frame) => /\/__virtual__\/[^/]+\/\d+\/(?:index\.html)?(?:\?.*)?$/u.test(frame.url()));
}

test("an app with a tarball dependency, a module worker, a nested iframe and a MessageChannel runs in the preview", async () => {
	await session.until("the workbench", () => session.workbench() !== undefined, 60_000);
	await session.workbench().evaluate(async (files) => {
		const api = await globalThis.__editor.ready.then(() => globalThis.__editor.api);

		for (const [path, text] of Object.entries(files)) {
			await api.workspace.fs.writeFile(api.Uri.file("/workspace/apps/wired/" + path), new TextEncoder().encode(text));
		}
	}, FILES);

	await session.terminal("cd apps/wired && vite", { "fresh": true });

	// The tarball's module was served by the dev server itself (no registry, no import map).
	await session.until("hub, from its tarball", hasLabel(/^preview:\d+$/u, "sw", /^GET \/@pkg\/@brianjenkins94\/hub\/index\.js$/u));

	const deadline = Date.now() + 60_000;
	let state;

	while (Date.now() < deadline) {
		state = await previewPage()?.evaluate(() => globalThis.__wired).catch(() => undefined);

		if (state?.results?.length > 0) {
			break;
		}

		await session.page.waitForTimeout(500);
	}

	assert.equal(state?.hub, "page", "the page's hub (from the tarball) is up: " + JSON.stringify(state));
	assert.deepEqual(state.results, [{ "echoed": "hi", "from": "worker" }], "the frame reached the worker across the channel, over hub");
});

test("a nested frame's console reaches the editor's log plane — tagged with its frame — and never the app's own page", async () => {
	const [record] = await eventually("the frame's log in debug-mcp", async () => {
		const found = debugMcp.store.queryLogs({ "source": "preview", "textIncludes": "wired frame says hi" });

		return found.length > 0 ? found : undefined;
	});

	assert.equal(record.attrs?.frame, "/frame.html");
	assert.equal((await previewPage().evaluate(() => globalThis.__wired)).stray, 0, "the app's page saw none of the tap's messages");
});

test("an edit to a module only the nested frame loaded reloads that frame, and leaves the page alone", async () => {
	const before = await previewPage().evaluate(() => ({ "startedAt": globalThis.__wired.startedAt, "title": document.title }));

	assert.equal(await nestedFrame()?.evaluate(() => document.title), "wired frame v1");
	await session.workbench().evaluate(async () => {
		const api = globalThis.__editor.api;
		const uri = api.Uri.file("/workspace/apps/wired/frame.ts");
		const text = new TextDecoder().decode(await api.workspace.fs.readFile(uri)).replace("wired frame v1", "wired frame v2");

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
	});

	await eventually("the frame reloaded with the edit", async () => (await nestedFrame()?.evaluate(() => document.title)) === "wired frame v2");

	// Give a stray update to the page (an import of frame.ts there, or a reload) time to happen.
	await session.page.waitForTimeout(1000);

	const page = await previewPage().evaluate(() => ({ ...globalThis.__wired, "title": document.title }));

	assert.equal(page.startedAt, before.startedAt, "the page wasn't reloaded");
	assert.equal(page.title, before.title, "nor frame.ts run in it (it sets the title)");
	assert.deepEqual(page.results, [{ "echoed": "hi", "from": "worker" }]);
});
