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
import { until } from "@brianjenkins94/util/until";

import { parseVirtual } from "../virtual-path.ts";
import { DEBUG_MCP_PORT, hasLabel, startSession } from "./architecture-harness.mjs";

const { createDebugMcp } = await import("../../debug-mcp/src/server.ts");

// (ARCH_HUB_TGZ / ARCH_OBSERVABILITY_TGZ: test against locally built tarballs before they're published.)
const HUB = process.env.ARCH_HUB_TGZ ?? "https://brianjenkins94.github.io/editor/packages/hub@latest.tgz";
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
		"// On every load: a reloaded frame (an edit to frame.ts) is a new page, and needs a new channel.",
		"frame.addEventListener(\"load\", () => {",
		"\tconst channel = new MessageChannel();",
		"",
		"\tworker.postMessage({ \"port\": channel.port1 }, [channel.port1]);",
		"\tframe.contentWindow!.postMessage({ \"port\": channel.port2 }, location.origin, [channel.port2]);",
		"});",
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
		"",
		"// A lobby like netsim's: the first window of this app to take the lock hosts, a later one is a guest; they talk",
		"// over a BroadcastChannel — what netsim's players rest on across windows of one server.",
		"const lobby = new BroadcastChannel(\"wired.lobby\");",
		"const lobbyState: { \"role\"?: string; \"heard\": string[] } = { \"heard\": [] };",
		"",
		"(globalThis as unknown as { \"__wiredLobby\": typeof lobbyState }).__wiredLobby = lobbyState;",
		"lobby.addEventListener(\"message\", (event) => {",
		"\tlobbyState.heard.push(String(event.data));",
		"",
		"\tif (lobbyState.role === \"host\" && event.data === \"hello from a guest\") {",
		"\t\tlobby.postMessage(\"welcome from the host\");",
		"\t}",
		"});",
		"void navigator.locks.request(\"wired.host\", { \"ifAvailable\": true }, async (lock) => {",
		"\tlobbyState.role = lock === null ? \"guest\" : \"host\";",
		"",
		"\tif (lock === null) {",
		"\t\tlobby.postMessage(\"hello from a guest\");",
		"",
		"\t\treturn;",
		"\t}",
		"",
		"\tawait new Promise(() => undefined); // hold it while this page lives",
		"});",
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
		"console.log(\"wired worker says hi\");",
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
		"\t\t(globalThis as unknown as { \"__wiredFrame\": typeof hub }).__wiredFrame = hub; // (for a failing test to say what the frame saw)",
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

/** Poll `probe` (in this process) until it's truthy, waiting the way the page does. */
function eventually(what, probe, timeoutMs = 60_000) {
	return until(what, probe, { "timeoutMs": timeoutMs, "intervalMs": 250, "sleep": (ms) => session.page.waitForTimeout(ms) });
}

/** The frame the app nests in its page. */
function nestedFrame() {
	return previewPage()?.childFrames().find((frame) => frame.url().includes("frame.html"));
}

/** The frame's answers so far — one per load of it (an edit reloads it): each must be the worker's echo. */
function assertEchoes(results, message) {
	assert.ok(results.length > 0 && results.every((result) => result.echoed === "hi" && result.from === "worker"), (message ?? "the frame reached the worker") + ": " + JSON.stringify(results));
}

/** Every preview window's top page (not their nested frames), in the order the windows opened. */
function previewPages() {
	return session.page.frames().filter((frame) => ["/", "/index.html"].includes(parseVirtual(new URL(frame.url()).pathname)?.rest));
}

/** The preview's (first window's) top page. */
function previewPage() {
	return previewPages()[0];
}

/** The preview's port. */
function previewPort() {
	return parseVirtual(new URL(previewPage().url()).pathname).port;
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
		// The preview window's console, by the window (`preview:<port>` — its port's first).
		const found = debugMcp.store.queryLogs({ "source": "preview:" + previewPort(), "textIncludes": "wired frame says hi" });

		return found.length > 0 ? found : undefined;
	});

	assert.equal(record.attrs?.frame, "/frame.html");
	assert.equal((await previewPage().evaluate(() => globalThis.__wired)).stray, 0, "the app's page saw none of the tap's messages");
});

test("a worker's console reaches the editor's log plane too — through the worker tap, tagged with its worker", async () => {
	const [record] = await eventually("the worker's log in debug-mcp", async () => {
		const found = debugMcp.store.queryLogs({ "source": "preview:" + previewPort(), "textIncludes": "wired worker says hi" });

		return found.length > 0 ? found : undefined;
	});

	assert.equal(record.attrs?.worker, "/worker.ts");
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
	// The reloaded frame got a new channel from the page, and reached the worker again.
	await eventually("the reloaded frame's answer", async () => (await previewPage().evaluate(() => globalThis.__wired.results.length)) === 2);
	assertEchoes((await previewPage().evaluate(() => globalThis.__wired)).results);
});

test("the app's own hubs join the editor's tree: its startup log, its tab and its tools reach debug-mcp through it", async () => {
	const logs = await eventually("the app's startup log", async () => {
		// Under its window: every window of an app names its sources alike, so the editor scopes them.
		const found = debugMcp.store.queryLogs({ "source": "preview:" + previewPort() + "/wired-page", "textIncludes": "wired page up" });

		return found.length > 0 ? found : undefined;
	});

	assert.equal(logs.length, 1, "logged before the link was up, and delivered once");

	const app = await eventually("the app's tab", async () => (await debugMcp.tabs(2000)).find((tab) => tab.preview === true));
	const answer = await debugMcp.rpc.request("tool.wired_status." + app.tab, {}, { "timeoutMs": 5000, "waitForResponderMs": 5000 });

	assertEchoes(answer.results, "its tool answered, through the editor's tree");
	assert.ok((await debugMcp.tabs(2000)).some((tab) => tab.preview !== true), "beside the editor's own tab");
});

test("the app's link is confined: an editor subject it publishes doesn't cross into the editor", async () => {
	const port = previewPort();

	await previewPage().evaluate((closing) => { globalThis.__wiredHub.publish("preview.close", { "port": closing }); }, port);
	await session.page.waitForTimeout(1500);
	assert.ok(previewPage() !== undefined, "the preview is still open");
});

test("the editor's architecture view takes the app's contexts as the app's: none of it needs review", async () => {
	// The app's hubs, workers and frames are reported into the editor's view (they joined its tree), named by the shell
	// as they enter: its page IS its preview window (`preview:<port>`), the rest under it (`preview:<port>/<hub>`). But
	// they're not the editor's architecture: nothing to check them against, and nothing flagged.
	const window = "preview:" + previewPort();
	const snapshot = await session.until("the app's hubs in the view", (current) => [window, window + "/worker"].every((id) => current.topology?.[id] !== undefined));

	assert.ok(snapshot.nodes.some((node) => node.id === window + "/frame"), "its nested frame's hub too");
	assert.ok(!snapshot.nodes.some((node) => node.id === window + "/page"), "its page is the window, not a context under it");
	assert.deepEqual((await session.conformance()).filter((violation) => violation.id !== override()), []);

	// And where they run, as each says: the frame in the page (the window); the worker under the page that started it.
	const layout = await appLayoutOnce((latest) => [window, window + "/frame", window + "/worker"].every((id) => latest.realms?.[id] !== undefined));

	assert.equal(layout.parent.get(window + "/frame"), window);
	assert.equal(layout.parent.get(window + "/worker"), window, "the page's tap told the worker who started it");
});

test("the app opens its own page as a new window: a second preview window onto the same server, its own page in every way", async () => {
	const port = previewPort();
	const second = "preview:" + port + "~2";

	// As a desktop app would open another tab: the editor's tap hands it to the shell, which opens another window.
	assert.equal(await previewPage().evaluate(() => window.open(location.href)), null, "no browser window to hand back");

	const [, page] = await eventually("a second preview window", async () => (previewPages().length === 2 ? previewPages() : undefined));
	const state = await eventually("its app running", async () => {
		const current = await page.evaluate(() => globalThis.__wired).catch(() => undefined);

		return current?.results?.length > 0 ? current : undefined;
	});

	assert.deepEqual(state.results, [{ "echoed": "hi", "from": "worker" }], "its own worker, frame and channel");

	// Both windows are one origin (one server), as tabs of it would be on a desktop: the first took the host lock, the
	// second is a guest, and they reach each other over a BroadcastChannel — what netsim's lobby rests on.
	assert.equal(await previewPage().evaluate(() => globalThis.__wiredLobby.role), "host");
	assert.equal(await page.evaluate(() => globalThis.__wiredLobby.role), "guest");
	await eventually("the host's welcome", async () => (await page.evaluate(() => globalThis.__wiredLobby.heard)).includes("welcome from the host"));
	assert.ok((await previewPage().evaluate(() => globalThis.__wiredLobby.heard)).includes("hello from a guest"));
	assert.notEqual(state.startedAt, (await previewPage().evaluate(() => globalThis.__wired)).startedAt, "its own page");

	// Its own hubs in the architecture, apart from the first window's (the same ids, scoped), and nothing flagged.
	const snapshot = await session.until("the second window's hubs", (current) => [second, second + "/worker", second + "/frame"].every((id) => current.topology?.[id] !== undefined));

	assert.ok(snapshot.topology?.["preview:" + port] !== undefined, "the first window's still there");
	assert.deepEqual((await session.conformance()).filter((violation) => violation.id !== override()), []);

	const layout = await appLayoutOnce((latest) => latest.realms?.[second + "/frame"] !== undefined);

	assert.equal(layout.parent.get(second + "/frame"), second, "its frame in its own window, though both windows' frames have one address");
	assert.equal(layout.parent.get(second + "/worker"), second);

	// Its own tab in debug-mcp — each naming its window, the scope its records are filed under (protocol 2: a page on
	// an older observability doesn't say).
	const previews = await eventually("two preview tabs", async () => {
		const tabs = (await debugMcp.tabs(2000)).filter((tab) => tab.preview === true);

		return tabs.length === 2 ? tabs : undefined;
	});

	if (previews.every((tab) => (tab.protocol ?? 0) >= 2)) {
		assert.deepEqual(previews.map((tab) => tab.scope).sort(), ["preview:" + port, second].sort());
	}

	// An edit reaches both windows' frames.
	await session.workbench().evaluate(async () => {
		const api = globalThis.__editor.api;
		const uri = api.Uri.file("/workspace/apps/wired/frame.ts");
		const text = new TextDecoder().decode(await api.workspace.fs.readFile(uri)).replace("wired frame v2", "wired frame v3");

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
	});
	await eventually("both windows' frames reloaded", async () => {
		const titles = await Promise.all(previewPages().map(async (top) => top.childFrames().find((frame) => frame.url().includes("frame.html"))?.evaluate(() => document.title)));

		return titles.length === 2 && titles.every((title) => title === "wired frame v3");
	});

	// Closing the second window leaves the first — and its server — running.
	await session.page.evaluate((title) => {
		const pane = [...document.querySelectorAll(".wa-win")].find((element) => element.querySelector(".wa-win__title")?.textContent?.startsWith(title));

		[...pane.querySelectorAll("wa-button")].find((button) => button.title === "Close").click();
	}, "Preview :" + port + " (2)");
	await eventually("one window again", async () => previewPages().length === 1);
	await session.page.waitForTimeout(1000);
	assert.equal(previewPages().length, 1, "the first window stays");
	assertEchoes((await previewPage().evaluate(() => globalThis.__wired)).results);
});

/** A locally served observability tarball (ARCH_OBSERVABILITY_TGZ) is a network endpoint only this run uses. */
function override() {
	return process.env.ARCH_OBSERVABILITY_TGZ === undefined ? undefined : "net:" + new URL(process.env.ARCH_OBSERVABILITY_TGZ).host;
}

/** appLayout over the view's current store, once `ready` holds for it. */
async function appLayoutOnce(ready) {
	const { appLayout } = await import("../architecture-model.ts");
	let last;
	const current = await session.until("the app's realms", (latest) => {
		last = latest;

		return ready(latest);
	}).catch(async (error) => {
		// What the frame itself saw: whether its reports had anyone to go to, and its links.
		const frame = await nestedFrame()?.evaluate(() => {
			const hub = globalThis.__wiredFrame;

			return hub === undefined ? "no hub" : JSON.stringify({ "listened": hub.interested("$sys.arch.frame"), "links": hub.inspect().links.map((link) => ({ "peer": link.peerId, "interest": link.remoteInterest })) });
		}).catch((cause) => "unreachable: " + cause.message);

		throw new Error(error.message + " — realms reported: " + Object.keys(last?.realms ?? {}).join(", ") + "; topology reported: " + Object.keys(last?.topology ?? {}).join(", ") + "; the frame saw: " + frame);
	});

	return appLayout({ "channels": current.channels, "topology": new Map(Object.entries(current.topology)), "realms": new Map(Object.entries(current.realms)) });
}
