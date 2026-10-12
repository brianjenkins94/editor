/**
 * Pane views (EXTENSION-POINTS.md, 4): a tab in the pane beside the editor, provided as data by an extension loaded from
 * outside the editor (test/fixtures/pane-view, in the web worker extension host as editor-contrib's is) — drawn level
 * with the code each item is about, placed each way an item can be (lines, a span reference, a range in a text that
 * ran, followed as the file changes), its buttons and input running its commands; and items it adds into the Margin.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { readFile } from "node:fs/promises";
import http from "node:http";
import { after, before, test } from "node:test";
import { until } from "@brianjenkins94/util/until";
import { startSession } from "./architecture-harness.mjs";

const FIXTURE = new URL("fixtures/pane-view/", import.meta.url);
const PORT = 5192;
// The editor's extension host takes http code only from localhost (its CSP).
const EXTENSION = `http://localhost:${PORT}/`;
const PROBE = "/workspace/pane-probe.js";

let server;
let session;

before(async () => {
	assert.ok(fs.existsSync(new URL("extension.js", FIXTURE)), "the fixture extension");

	server = http.createServer((request, response) => {
		const file = new URL("." + new URL(request.url, EXTENSION).pathname, FIXTURE);

		readFile(file).then((body) => {
			response.writeHead(200, { "access-control-allow-origin": "*", "content-type": file.pathname.endsWith(".json") ? "application/json" : "text/javascript" });
			response.end(body);
		}, () => {
			response.writeHead(404, { "access-control-allow-origin": "*" });
			response.end();
		});
	});
	await new Promise((resolve) => { server.listen(PORT, resolve); });
	session = await startSession({ "prepare": (context) => context.route("**/extensions.json", (route) => route.fulfill({ "json": [EXTENSION] })) });
});

after(async () => {
	await session?.close("pane-views");
	server?.close();
});

function eventually(what, probe, timeoutMs = 60_000) {
	return until(what, probe, { "timeoutMs": timeoutMs, "intervalMs": 250, "sleep": (ms) => session.page.waitForTimeout(ms) });
}

/** The pane's cells, each with its first line and its text. */
function cells(workbench) {
	return workbench.evaluate(() => [...document.querySelectorAll(".notes-margin-cell")].map((cell) => ({ "line": Number(cell.dataset.line), "text": cell.textContent })));
}

test("an extension's pane view: its tab, its items level with their code, followed as it changes, its buttons and input", async () => {
	const workbench = await eventually("the workbench", async () => session.workbench());

	await eventually("the extension loaded", () => workbench.evaluate(async () => {
		await globalThis.__editor?.ready;
		await globalThis.__editor?.contributed;

		return globalThis.__editor?.contributed !== undefined;
	}).catch(() => false));

	await workbench.evaluate(async (path) => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file(path);

		await api.workspace.fs.writeFile(uri, new TextEncoder().encode("// a probe\nconst x = [1, 22];\nconst longer = 333;\nconst typed = \"\";\nconst z = 3;\nconst later = 4;\n"));
		await api.window.showTextDocument(uri);
	}, PROBE);

	// Into the Margin: the extension's item among the Margin's own.
	await eventually("its item in the Margin", async () => (await cells(workbench)).some((cell) => cell.line === 0 && cell.text.includes("into the margin")));

	// Its own tab.
	await workbench.locator(".notes-margin-tab", { "hasText": "Probe" }).click();

	const shown = await eventually("its view", async () => {
		const now = await cells(workbench);

		return now.some((cell) => cell.text.includes("followed from the run")) && now.some((cell) => cell.text.includes("on its span")) ? now : undefined;
	});
	const at = (text) => shown.find((cell) => cell.text.includes(text))?.line;

	assert.equal(at("hello"), 0, "markdown on its line");
	assert.equal(at("x ="), 1, "a row on its line");
	assert.equal(at("longer ="), 2);
	assert.equal(at("on its span"), 4, "a span reference, on its span");
	assert.equal(at("followed from the run"), 5, "a range in the text that ran, on its line");
	assert.equal(shown.some((cell) => cell.text.includes("into the margin")), false, "the Margin's items aren't in another view");

	// Rows on consecutive lines line their labels up.
	const labels = await workbench.evaluate(() => [...document.querySelectorAll(".notes-margin-cell .live-values-label")].map((label) => label.textContent));

	assert.deepEqual(labels.filter((label) => label.trim() === "x =" || label.trim() === "longer ="), ["x =     ", "longer ="]);
	assert.equal(await workbench.evaluate(() => [...document.querySelectorAll(".notes-margin-group-label")].map((label) => label.textContent).join("|")), "a stepran", "its card, and how it ran");
	assert.ok(await workbench.evaluate(() => [...document.querySelectorAll(".notes-margin-mark")].some((mark) => mark.title === "ran twice" && mark.classList.contains("coverage-ran"))), "its gutter mark");

	// The file changes: two lines above — each item follows its code.
	await workbench.evaluate(async (path) => {
		const { api } = globalThis.__editor;
		const uri = api.Uri.file(path);
		const edit = new api.WorkspaceEdit();

		edit.insert(uri, new api.Position(1, 0), "// one\n// two\n");
		await api.workspace.applyEdit(edit);
	}, PROBE);

	const moved = await eventually("its items followed", async () => {
		const now = await cells(workbench);
		const line = (text) => now.find((cell) => cell.text.includes(text))?.line;

		return line("followed from the run") === 7 && line("on its span") === 6 ? now : undefined;
	});

	assert.ok(moved.some((cell) => cell.line === 0 && cell.text.includes("hello")), "lines as given stay as given");

	// Its button runs its command, and its content says so.
	await workbench.locator(".notes-margin-cell .live-values-choice", { "hasText": "Click" }).click();
	await eventually("the click, in its content", async () => (await cells(workbench)).some((cell) => cell.text.includes("clicked a")));

	// Its input submits what was typed.
	const input = workbench.locator(".notes-margin-cell input.live-values-input");

	await input.fill("hi there");
	await input.press("Enter");
	await eventually("what was typed, in its content", () => workbench.evaluate(() => document.querySelector(".notes-margin-cell input.live-values-input")?.value === "hi there"));

	// Back to the Margin.
	await workbench.locator(".notes-margin-tab", { "hasText": "Margin" }).click();
	await eventually("the Margin again", async () => (await cells(workbench)).some((cell) => cell.text.includes("into the margin")));

	await workbench.evaluate(async (path) => {
		const { api } = globalThis.__editor;

		await api.commands.executeCommand("workbench.action.revertAndCloseActiveEditor");
		await api.workspace.fs.delete(api.Uri.file(path)).then(() => undefined, () => undefined);
	}, PROBE);
});
