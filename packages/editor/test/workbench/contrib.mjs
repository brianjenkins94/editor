/**
 * editor-contrib still plugs in: contrib/ — the starting point a third party's interpreter and renderer are built from,
 * kept in brianjenkins94/editor-contrib — loaded into a real editor as editor-contrib's site loads it (the site's
 * extensions.json lists it; here a route answers for it). What its README promises: Run, an agent's run and a live run
 * start its interpreter, not the editor's, and its Rendered view draws. A change to the editor that
 * breaks any of that fails here, before contrib/ goes to editor-contrib (.github/workflows/contrib.yml).
 *
 * Needs contrib/ built (its `build` script: dist/extension.js), as the workflow's workspace build does.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/workbench/contrib.mjs
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as http from "node:http";
import { after, test } from "node:test";
import * as fs from "@brianjenkins94/util/fs";

import { sharedSession } from "../architecture-harness.mjs";

const CONTRIB = new URL("../../../../contrib/", import.meta.url);
const PORT = 5191;
// (the editor's extension host takes http code only from localhost, by its CSP)
const EXTENSION = `http://localhost:${String(PORT)}/`;
const PROGRAM = "const greeting = \"hello\";\n\nconsole.log(greeting);\n";

const server = http.createServer((request, response) => {
	const file = new URL("." + new URL(request.url, EXTENSION).pathname, CONTRIB);

	readFile(file).then((body) => {
		response.writeHead(200, { "access-control-allow-origin": "*", "content-type": file.pathname.endsWith(".json") ? "application/json" : "text/javascript" });
		response.end(body);
	}, () => {
		response.writeHead(404, { "access-control-allow-origin": "*" });
		response.end();
	});
});

assert.ok(fs.existsSync(new URL("dist/extension.js", CONTRIB)), "contrib/ is built (its build script)");
await new Promise((resolve) => {
	server.listen(PORT, resolve);
});

const session = sharedSession("contrib", { "prepare": (context) => context.route("**/extensions.json", (route) => route.fulfill({ "json": [EXTENSION] })) });

after(() => {
	server.close();
});

/** What ran, as VS Code tells every extension: each session's debug type, and the custom events it sent. */
const seen = async () => session.workbench().evaluate(() => globalThis.__contrib);

let started;

/** The editor with the extension loaded and a program open, once: what each test starts from. */
const ready = () => (started ??= (async () => {
	await session.eventually("the extension's interpreter as what Run starts", async () => (await session.workbench().evaluate(() => globalThis.__editor?.api.workspace.getConfiguration("run").get("debugger")).catch(() => undefined)) === "contrib" ? true : undefined, 60_000);
	await session.workbench().evaluate(async (program) => {
		const { api } = globalThis.__editor;
		const told = { "sessions": [], "events": [] };

		globalThis.__contrib = told;
		api.debug.onDidStartDebugSession((started) => { told.sessions.push({ "type": started.type, "live": started.configuration.__live === true }); });
		api.debug.onDidReceiveDebugSessionCustomEvent((event) => { told.events.push({ "type": event.session.type, "event": event.event }); });
		await api.workspace.fs.writeFile(api.Uri.file("/workspace/contrib-probe.ts"), new TextEncoder().encode(program));
		await api.window.showTextDocument(await api.workspace.openTextDocument(api.Uri.file("/workspace/contrib-probe.ts")), { "preview": false });
	}, PROGRAM);
})());

test("Run (▷) starts the interpreter plugged in, which tells its values, coverage, effects and end", async () => {
	await ready();

	await session.workbench().locator(".editor-actions [aria-label^='Run']").first().click();

	const told = await session.eventually("its end", async () => {
		const now = await seen();

		return now.events.some(({ event }) => event === "ended") ? now : undefined;
	}, 60_000);

	assert.deepEqual([...new Set(told.sessions.map(({ type }) => type))], ["contrib"]);
	assert.deepEqual([...new Set(told.events.map(({ event }) => event))].toSorted(), ["coverage", "effects", "ended", "values"]);
	await session.workbench().evaluate(() => globalThis.__editor.api.commands.executeCommand("workbench.debug.action.focusRepl"));
	// (the template's interpreter says what it would run, read through the editor's runtime: the text's length)
	await session.workbench().locator(".repl", { "hasText": `would run /workspace/contrib-probe.ts (${String(PROGRAM.length)} characters)` }).waitFor({ "timeout": 30_000 });

	// Its session is a run, by what ran it.
	const run = await session.eventually("its run", async () => (await session.request("runs.list", undefined, 5000)).find((each) => each.runtime === "contrib" && each.state !== "running"), 30_000);

	assert.equal(run.state, "exited");
});

test("an agent's run starts it too", async () => {
	await ready();

	const before = (await seen()).sessions.length;
	const ran = await session.request("debug.start", { "program": "/workspace/contrib-probe.ts", "breakpoints": [] }, 60_000);

	assert.equal(ran.state, "terminated");
	assert.deepEqual((await seen()).sessions.slice(before).map(({ type }) => type), ["contrib"]);
});

test("a live run, on a save, is its own as well", async () => {
	await ready();

	const before = (await seen()).sessions.length;

	await session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;
		const editor = api.window.visibleTextEditors.find((each) => each.document.uri.path === "/workspace/contrib-probe.ts");

		await editor.edit((edit) => { edit.insert(new api.Position(0, 0), "const first = 1;\n"); });
		await editor.document.save();
	});

	const live = await session.eventually("a live run", async () => (await seen()).sessions.slice(before).find((each) => each.live), 60_000);

	assert.equal(live.type, "contrib");
});

test("its Rendered view draws the file", async () => {
	await ready();

	await session.workbench().evaluate(async () => {
		const { api } = globalThis.__editor;

		await api.commands.executeCommand("vscode.openWith", api.Uri.file("/workspace/contrib-probe.ts"), "contrib.renderer");
	});

	await session.eventually("the file rendered", async () => {
		for (const frame of session.page.frames()) {
			if (frame.url().includes("/webview/fake")) {
				const text = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");

				if (text.includes("greeting")) {
					return true;
				}
			}
		}

		return undefined;
	}, 60_000);
});

test("a webview leaves the workbench to the editor's own service worker", async () => {
	await ready();

	const controller = await session.workbench().evaluate(() => navigator.serviceWorker.controller?.scriptURL ?? "");

	assert.match(controller, /\/coi-serviceworker\.js/u);
	// (its own, only its own folder)
	assert.deepEqual(await session.workbench().evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(({ scope }) => new URL(scope).pathname).toSorted()), ["/", "/__vscode__/webview/"]);
});
