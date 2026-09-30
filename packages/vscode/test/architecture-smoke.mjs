/**
 * Architecture smoke test: drive a real session in a fresh headless Chromium — boot, run the demo's preview from the
 * terminal, edit + save a file (HMR) — then check what the live architecture view observed against the channels
 * that MUST show up, and that nothing needs review. The probes patch VS Code internals and wrap transports by hand;
 * when one stops reporting, the diagram just goes quiet — this is what makes that a failure.
 *
 *   node --test test/architecture-smoke.mjs      (see architecture-harness.mjs for the browser + dev server)
 *
 * The observed snapshot is left in $TMPDIR/architecture-smoke.json.
 */
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { alive, between, hasLabel, startSession } from "./architecture-harness.mjs";

const { channels, hubLinks, nodes, seenChannels } = await import("../architecture-model.ts");

const PREVIEW = "preview:5173";

/** Declared channels a boot + preview + save always exercises (`a ⇄ b` exactly as declared in the model). */
const MUST_SEE_CHANNELS = [
	"workbench ⇄ worker:*",
	"pod ⇄ worker:server-host",
	"workbench ⇄ exthost:LocalProcess:*",
	"workbench ⇄ exthost-iframe",
	"workbench ⇄ exthost:LocalWebWorker:*",
	"exthost:LocalWebWorker:* ⇄ nested:*",
	"workbench ⇄ sw",
	"sw ⇄ net:*",
	"workbench ⇄ idb",
	"shell ⇄ preview:*",
	"preview:* ⇄ sw",
	"node ⇄ vite:*",
	"workbench ⇄ zenfs",
	"node ⇄ zenfs",
	"worker:server-host ⇄ zenfs",
	"zenfs ⇄ idb"
];

/** Specific messages, by the pair they cross: one per hand-wired probe or hub route. */
const MUST_SEE_LABELS = [
	["node", "workbench", /^workspace\.buffer\(\)$/u],
	["workbench", "node", /^workspace\.changed$/u],
	["sw", "root", /^virtual\.request\.[\w*]+\(\)$/u], // addressed to its tab (the id folds to `*`)
	[PREVIEW, "sw", /^GET \/src\/main\.tsx$/u],
	["sw", "net:esm.sh", /^GET /u],
	["node", "vite:5173", /^file changed$/u], // the save, as workspace.changed
	["node", "vite:5173", /^hmr /u],
	[PREVIEW, "shell", /^hmr /u],
	[PREVIEW, "shell", /^obs-log$/u],
	["workbench", "zenfs", /^vscode · write$/u],
	["zenfs", "workbench", /^onDidChangeFile$/u],
	["node", "zenfs", /^mount \/workspace/u],
	// tsserver's synchronous file system (the @vscode/sync-api bridge, over a transferred port)
	[/^exthost:LocalWebWorker:/u, /^nested:TS /u, /^fileSystem\//u]
];

let session;

before(async () => { session = await startSession(); });
after(async () => { await session?.close("architecture-smoke"); });

test("boot: every realm reports", async () => {
	for (const id of ["shell", "root", "sw", "workbench", "pod", "node"]) {
		await session.until(id + " alive", alive(id));
	}

	await session.until("tsserver's sync file system", hasLabel(/^exthost:LocalWebWorker:/u, /^nested:TS /u, /^fileSystem\//u));
});

test("preview: npm run dev in the terminal serves the demo", async () => {
	await session.terminal("npm run dev");
	await session.until("the preview's first module", hasLabel(PREVIEW, "sw", /^GET \/src\/main\.tsx$/u));
});

test("hmr: a save reaches the preview", async () => {
	await session.open("App.tsx");
	await session.append("// architecture smoke");
	await session.page.keyboard.press("ControlOrMeta+s");
	await session.until("an HMR update in the preview", hasLabel(PREVIEW, "shell", /^hmr /u));
});

test("coverage: every must-see hub link, channel and message was observed", async () => {
	const current = await session.until("the zen-fs IndexedDB flush", hasLabel("zenfs", "idb", /files\.put$/u), 10_000).catch(() => session.snapshot());
	const seen = seenChannels(current.channels.map((channel) => ({ ...channel, "labels": new Map(Object.entries(channel.labels)) })));
	const missing = [];

	for (const [a, b] of hubLinks) {
		// Links to contexts that exist only under a condition (debug-mcp running, a debug session) aren't required.
		const conditional = [a, b].some((id) => nodes.find((node) => node.id === id)?.condition !== undefined);

		if (!conditional && between(current, a, b).length === 0) {
			missing.push(`hub link ${a} ⇄ ${b}`);
		}
	}

	for (const pair of MUST_SEE_CHANNELS) {
		const [a, b] = pair.split(" ⇄ ");
		const spec = channels.find((channel) => channel.a === a && channel.b === b);

		assert.ok(spec !== undefined, "not a declared channel: " + pair);

		if (!seen.has(spec)) {
			missing.push("channel " + pair);
		}
	}

	for (const [a, b, label] of MUST_SEE_LABELS) {
		if (!hasLabel(a, b, label)(current)) {
			missing.push(`message ${String(label)} between ${String(a)} and ${String(b)}`);
		}
	}

	assert.deepEqual(missing, []);
});

test("conformance: nothing observed needs review", async () => {
	assert.deepEqual(await session.conformance(), []);
});
