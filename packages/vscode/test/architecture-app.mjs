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
// (ARCH_OBSERVABILITY_TGZ: test against a locally built observability tarball before it's published.)
const OBSERVABILITY = process.env.ARCH_OBSERVABILITY_TGZ ?? "https://brianjenkins94.github.io/editor/packages/observability@latest.tgz";
const UTIL = "https://brianjenkins94.github.io/lib/util@latest.tgz";

const FILES = {
	"package.json": JSON.stringify({ "name": "wired", "private": true, "type": "module", "dependencies": { "@brianjenkins94/hub": HUB, "@brianjenkins94/observability": OBSERVABILITY, "@brianjenkins94/util": UTIL } }, null, "\t"),
	"index.html": "<!doctype html>\n<html><head><title>wired</title></head><body><script type=\"module\" src=\"./main.ts\"></script></body></html>\n",
	"frame.html": "<!doctype html>\n<html><head><title>wired frame</title></head><body><script type=\"module\" src=\"./frame.ts\"></script></body></html>\n",
	// The page: starts the worker, adds the frame, and hands each one end of a channel between them.
	"main.ts": [
		"import { createHub, portTransport } from \"@brianjenkins94/hub\";",
		"import { createArchReporter, linkPreviewHost, relayLoggerToHub, servePageTools } from \"@brianjenkins94/observability\";",
		"",
		"const hub = createHub({ \"id\": \"page\" });",
		"const state: { \"hub\": string; \"results\": unknown[]; \"stray\": number; \"startedAt\": number } = { \"hub\": hub.id, \"results\": [], \"stray\": 0, \"startedAt\": performance.timeOrigin };",
		"",
		"// The app's own observability, joining the editor's tree: a tool of its own, and its logs.",
		"servePageTools(hub, { \"tools\": [{ \"name\": \"wired_status\", \"description\": \"The wired app's state.\", \"inputSchema\": { \"type\": \"object\" }, \"handler\": () => ({ \"results\": state.results, \"stray\": state.stray }) }] });",
		"linkPreviewHost(hub);",
		"createArchReporter(hub);",
		"relayLoggerToHub(hub, \"wired-page\").info(\"wired page up\");",
		"(globalThis as unknown as { \"__wiredHub\": typeof hub }).__wiredHub = hub;",
		"const worker = new Worker(new URL(\"./worker.ts\", import.meta.url), { \"type\": \"module\" });",
		"",
		"hub.link(portTransport(worker));",
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
	// The worker: in the page's tree, and serving an RPC on its end of the channel to the frame.
	"worker.ts": [
		"import { createHub, portTransport, serve } from \"@brianjenkins94/hub\";",
		"import { createArchReporter } from \"@brianjenkins94/observability\";",
		"",
		"const hub = createHub({ \"id\": \"worker\" });",
		"",
		"hub.link(portTransport(globalThis));",
		"createArchReporter(hub);",
		"serve(hub, \"wired.echo\", (args) => ({ \"echoed\": args, \"from\": hub.id }));",
		"addEventListener(\"message\", (event: MessageEvent) => {",
		"\tif (event.data?.port instanceof MessagePort) {",
		"\t\thub.link(portTransport(event.data.port));",
		"\t}",
		"});",
		""
	].join("\n"),
	// The frame: calls the worker over its end, and reports the answer to the page.
	"frame.ts": [
		"import { createHub, createRpcClient, portTransport } from \"@brianjenkins94/hub\";",
		"import { createArchReporter } from \"@brianjenkins94/observability\";",
		"",
		"document.title = \"wired frame v1\";",
		"",
		"addEventListener(\"message\", async (event: MessageEvent) => {",
		"\tif (event.source === parent && event.data?.port instanceof MessagePort) {",
		"\t\tconst hub = createHub({ \"id\": \"frame\" });",
		"",
		"\t\thub.link(portTransport(event.data.port));",
		"\t\tcreateArchReporter(hub);",
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

test("the app's own hubs join the editor's tree: its startup log, its tab and its tools reach debug-mcp through it", async () => {
	const logs = await eventually("the app's startup log", async () => {
		const found = debugMcp.store.queryLogs({ "source": "wired-page", "textIncludes": "wired page up" });

		return found.length > 0 ? found : undefined;
	});

	assert.equal(logs.length, 1, "logged before the link was up, and delivered once");

	const app = await eventually("the app's tab", async () => (await debugMcp.tabs(2000)).find((tab) => tab.preview === true));
	const answer = await debugMcp.rpc.request("tool.wired_status." + app.tab, {}, { "timeoutMs": 5000, "waitForResponderMs": 5000 });

	assert.deepEqual(answer.results, [{ "echoed": "hi", "from": "worker" }], "its tool answered, through the editor's tree");
	assert.ok((await debugMcp.tabs(2000)).some((tab) => tab.preview !== true), "beside the editor's own tab");
});

test("the app's link is confined: an editor subject it publishes doesn't cross into the editor", async () => {
	const port = Number(/\/__virtual__\/[^/]+\/(\d+)\//u.exec(previewPage().url())?.[1]);

	await previewPage().evaluate((closing) => { globalThis.__wiredHub.publish("preview.close", { "port": closing }); }, port);
	await session.page.waitForTimeout(1500);
	assert.ok(previewPage() !== undefined, "the preview is still open");
});

test("the editor's architecture view takes the app's contexts as the app's: none of it needs review", async () => {
	// The app's hubs, workers and frames are reported into the editor's view (they joined its tree), but they're not
	// the editor's architecture: nothing to check them against, and nothing flagged.
	const snapshot = await session.until("the app's hubs in the view", (current) => ["page", "worker"].every((id) => current.nodes.some((node) => node.id === id)));

	assert.ok(snapshot.nodes.some((node) => node.id === "frame"), "its nested frame's hub too");

	// (A locally served observability tarball — ARCH_OBSERVABILITY_TGZ — is a network endpoint only this run uses.)
	const override = process.env.ARCH_OBSERVABILITY_TGZ === undefined ? undefined : "net:" + new URL(process.env.ARCH_OBSERVABILITY_TGZ).host;

	assert.deepEqual((await session.conformance()).filter((violation) => violation.id !== override), []);

	// And where they run, from the realms they report: the page is its preview; the frame sits in it.
	const { appLayout } = await import("../architecture-model.ts");
	const port = /\/__virtual__\/[^/]+\/(\d+)\//u.exec(previewPage().url())?.[1];
	const current = await session.until("the app's realms", (latest) => ["page", "frame"].every((id) => latest.realms?.[id] !== undefined));
	const layout = appLayout({ "channels": current.channels, "topology": new Map(Object.entries(current.topology)), "realms": new Map(Object.entries(current.realms)) });

	assert.equal(layout.alias.get("page"), "preview:" + port);
	assert.equal(layout.parent.get("frame"), "preview:" + port);
});
