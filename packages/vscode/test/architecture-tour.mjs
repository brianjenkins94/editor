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

// The model leaves webviews out on purpose (nothing here can serve them), so the Markdown preview the tour opens is
// flagged — accurately. Anything else needs review.
test("conformance: nothing observed needs review, beyond the webview the tour opened", async () => {
	const webview = (violation) => [violation.id, violation.a, violation.b].some((id) => id?.startsWith("webview") === true);

	assert.deepEqual((await session.conformance()).filter((violation) => !webview(violation)), []);
});
