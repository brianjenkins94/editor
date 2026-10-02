/**
 * Architecture tour: the paths a routine session never takes — a second preview, a node script under the tsval
 * debugger, a cold provoke round, a webview, the git review diff, and this checkout's debug-mcp — each checked
 * against what the live architecture view observed. Slower than the smoke test;
 * run it when the probes or those paths change.
 *
 *   node --test test/architecture-tour.mjs      (see architecture-harness.mjs for the browser + dev server)
 *
 * The observed snapshot is left in $TMPDIR/architecture-tour.json; declared channels still unseen are printed.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { until } from "@brianjenkins94/util/until";

import { alive, hasLabel, startSession } from "./architecture-harness.mjs";

const { channels, seenChannels } = await import("../architecture-model.ts");

let session;

before(async () => {
	session = await startSession({ "debugMcp": true });
	await session.until("the node worker", alive("node"));
});

after(async () => {
	const current = session?.snapshot();

	if (current !== undefined) {
		const seen = seenChannels(current.channels.map((channel) => ({ ...channel, "labels": new Map(Object.entries(channel.labels)) })));

		console.log("declared channels not seen:\n  " + channels.filter((channel) => !seen.has(channel)).map((channel) => `${channel.a} ⇄ ${channel.b}`).join("\n  "));
	}

	await session?.close("architecture-tour");
});

test("debug-mcp: this checkout's debug-mcp joins the hub tree", async () => {
	await session.until("root ⇄ debug-mcp", hasLabel("root", "debug-mcp", /^hello$/u));
});

test("previews: two dev servers side by side", async () => {
	await session.terminal("npm run dev");
	await session.until("preview :5173", hasLabel("preview:5173", "sw", /^GET /u));
	await session.terminal("cd apps/second && npm run dev", { "fresh": true });
	await session.until("preview :5174", hasLabel("preview:5174", "sw", /^GET /u));
	await session.until("its dev server", alive("vite:5174"));
});

test("provoke: a cold transform round in a child worker", async () => {
	await session.request("preview.provoke", { "rounds": 1, "hardReset": true }, 90_000);
	await session.until("node ⇄ provoke worker", hasLabel("node", "provoke", /./u));
	await session.until("the provoke worker's mount", hasLabel("provoke", "zenfs", /^mount /u));
});

// `node <file>` in the terminal runs under the tsval debugger (the debug worker), and a capability-gated call pauses
// it. The node worker's own script path — its synchronous capability check with the service worker (node ⇄ sw) and a
// script's http server (node ⇄ server:*) — is only taken when tsval declines to debug, so it isn't toured here.
test("node script: runs under the tsval debugger, with its render surface", async () => {
	await session.terminal(`echo "require('fs').writeFileSync('/workspace/tour-out.txt', 'tour');" > tour.js && node tour.js`, { "fresh": true });
	await session.until("the debug worker", alive("debug-worker"));
	await session.until("the debug session's launch", hasLabel("pod", "debug-worker", /^debug\.session\..+\.control$/u));
	await session.until("the tsval render surface", hasLabel("shell", "tsval-preview", /^init/u));
});

test("webview: a markdown preview", async () => {
	await session.terminal(`echo "# Tour" > TOUR.md`, { "fresh": true });
	await session.page.waitForTimeout(1000);
	await session.open("TOUR.md");
	await session.command("Markdown: Open Preview to the Side");
	await session.until("a webview", alive(/^webview:/u));
	await session.until("workbench ⇄ webview", hasLabel("workbench", /^webview:/u, /./u));
});

test("git review: a diff in the shell", async () => {
	await session.open("App.tsx");
	await session.append("// architecture tour");
	await session.page.keyboard.press("ControlOrMeta+s");
	await session.page.getByTitle("Expand changes panel").click();
	await session.page.waitForTimeout(1500);
	await session.page.getByText("App.tsx").last().click();
	await session.until("Code Hike", hasLabel("sw", "net:lighter.codehike.org", /./u), 30_000);
});

// VS Code's new windows are panels of the shell's dock (shell-dock.ts): an editor moved out lives on, its DOM in a
// blank frame of the shell, and comes back whichever side closes the window — VS Code (its editors restored to the
// main window) or the user (the panel closed).
test("dock: an editor moved into a new window lands in a panel of the shell's dock, and comes back", async () => {
	const { page } = session;
	const windows = page.locator("iframe[name^=\"vscode-window-\"]");
	const panel = page.locator(".dv-tab", { "hasText": "Editors" });
	const run = (command) => session.workbench().evaluate((id) => globalThis.__editor.api.commands.executeCommand(id), command);
	const editorsInWindow = () => windows.first().evaluate((frame) => frame.contentDocument?.querySelectorAll(".monaco-editor").length ?? 0).catch(() => 0);

	// (The git review's diff, still open over the editor region, would cover the dock's tabs.)
	if (await page.getByTitle("Close diff").isVisible()) {
		await page.getByTitle("Close diff").click();
	}

	await session.open("index.ts");
	await run("workbench.action.moveEditorToNewWindow");
	await eventually("the editor in a dock panel", async () => await windows.count() === 1 && await editorsInWindow() > 0);
	assert.equal(await panel.count(), 1, "its panel");

	// VS Code closes it: back into the main window, and the panel goes with the window.
	await run("workbench.action.restoreEditorsToMainWindow");
	await eventually("the window closed by VS Code", async () => await windows.count() === 0 && await panel.count() === 0);
	assert.ok(await session.workbench().locator(".tabs-container .tab", { "hasText": "index.ts" }).count() > 0, "the editor back in the main window");

	// The user closes it: the panel closed, the window gone from VS Code too.
	await run("workbench.action.moveEditorToNewWindow");
	await eventually("the editor in a dock panel again", async () => await windows.count() === 1 && await editorsInWindow() > 0);
	await panel.locator(".dv-default-tab-action").click();
	await eventually("the window closed by the user", async () => await windows.count() === 0 && await panel.count() === 0);
	assert.deepEqual(await session.conformance(), [], "nothing needs review");
});

test("conformance: nothing observed needs review", async () => {
	assert.deepEqual(await session.conformance(), []);
});

/** Poll `probe` (in this process) until it's truthy, waiting the way the page does. */
function eventually(what, probe, timeoutMs = 30_000) {
	return until(what, probe, { "timeoutMs": timeoutMs, "intervalMs": 250, "sleep": (ms) => session.page.waitForTimeout(ms) });
}
