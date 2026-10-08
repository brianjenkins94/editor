/**
 * editor-contrib still plugs in: contrib/ — the starting point a third party's interpreter and renderer are built from,
 * kept in brianjenkins94/editor-contrib — loaded into a real editor session by URL (`?extension=`), its debugger what
 * Run starts (`run.debugger`), each of its sessions a run, and its values and coverage reaching the editor. A change to
 * the editor that breaks any of that fails here, before contrib/ goes to editor-contrib.
 *
 * Needs contrib/ built (its `build` script: dist/extension.js), as the workflow's workspace build does.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as http from "node:http";
import { after, before, test } from "node:test";
import * as fs from "@brianjenkins94/util/fs";
import { until } from "@brianjenkins94/util/until";
import { startSession } from "./architecture-harness.mjs";

const CONTRIB = new URL("../../../contrib/", import.meta.url);
const PORT = 5191;
// The editor's extension host takes http code only from localhost (its CSP) — so this, not a *.localhost name.
const EXTENSION = `http://localhost:${PORT}/`;

let server;
let session;

before(async () => {
	assert.ok(fs.existsSync(new URL("dist/extension.js", CONTRIB)), "contrib/ is built (its build script)");

	// contrib/ served as its own site is (package.json + dist/), with the CORS the editor's fetch of it needs.
	server = http.createServer((request, response) => {
		const file = new URL("." + new URL(request.url, EXTENSION).pathname, CONTRIB);

		readFile(file).then((body) => {
			response.writeHead(200, { "access-control-allow-origin": "*", "content-type": file.pathname.endsWith(".json") ? "application/json" : "text/javascript" });
			response.end(body);
		}, () => {
			response.writeHead(404, { "access-control-allow-origin": "*" });
			response.end();
		});
	});
	await new Promise((resolve) => { server.listen(PORT, resolve); });
	session = await startSession({ "query": "?extension=" + encodeURIComponent(EXTENSION) });
});

after(async () => {
	await session?.close("contrib");
	server?.close();
});

/** Poll `probe` (in this process) until it's truthy, waiting the way the page does. */
function eventually(what, probe, timeoutMs = 60_000) {
	return until(what, probe, { "timeoutMs": timeoutMs, "intervalMs": 250, "sleep": (ms) => session.page.waitForTimeout(ms) });
}

test("Run starts editor-contrib's interpreter: a run, telling its values and coverage", async () => {
	const workbench = await eventually("the workbench", async () => session.workbench());

	await eventually("the extension loaded", () => workbench.evaluate(async () => {
		if (globalThis.__editor?.contributed === undefined) {
			return false;
		}

		await globalThis.__editor.ready;
		await globalThis.__editor.contributed;

		return true;
	}).catch(() => false));

	await workbench.evaluate(async () => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file("/workspace/contrib-probe.ts");
		const seen = { "sessions": [], "events": [] };

		globalThis.__contrib = seen;
		api.debug.onDidStartDebugSession((started) => { seen.sessions.push({ "type": started.type, "runId": started.configuration.__runId }); });
		api.debug.onDidReceiveDebugSessionCustomEvent((event) => { seen.events.push({ "type": event.session.type, "event": event.event }); });
		await api.workspace.fs.writeFile(uri, new TextEncoder().encode("const greeting = \"hello\";\nconsole.log(greeting);\n"));
		await api.workspace.getConfiguration("run").update("debugger", "contrib", api.ConfigurationTarget.Global);
		await api.commands.executeCommand("editor.debugFile", uri);
	});

	const seen = await eventually("its coverage", () => workbench.evaluate(() => (globalThis.__contrib.events.some((each) => each.event === "coverage") ? globalThis.__contrib : undefined)));

	assert.deepEqual(seen.sessions.map((each) => each.type), ["contrib"], "Run started editor-contrib's debugger");
	assert.deepEqual(seen.events.map((each) => each.event), ["values", "coverage"], "it told its values, then its coverage");
	assert.equal(typeof seen.sessions[0].runId, "string", "its session is a run");

	const run = await eventually("its run, ended", async () => (await session.request("runs.list", undefined, 5000)).find((each) => each.id === seen.sessions[0].runId && each.state !== "running"));

	assert.equal(run.runtime, "contrib", "the run says what ran it");
	assert.equal(run.state, "exited");
});

test("editor.annotations.spans gives an extension the editor's spans for a text", async () => {
	const spans = await session.workbench().evaluate(() => globalThis.__editor.api.commands.executeCommand("editor.annotations.spans", "const greeting = \"hello\";\n"));

	assert.ok(Array.isArray(spans) && spans.length > 0, "the text's spans");
	assert.ok(spans.every((span) => typeof span.id === "string" && span.start <= span.end), "each one's id and offsets");
});
