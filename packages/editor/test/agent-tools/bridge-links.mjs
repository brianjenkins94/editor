/**
 * The bridge's links: the extension host's one hub, linked to the workbench's, and a debug run's worker linked to it.
 *
 *   node --test --test-global-setup=test/architecture-harness.mjs test/agent-tools/bridge-links.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { sharedSession } from "../architecture-harness.mjs";

const session = sharedSession("bridge-links");
const { ask, runTests } = session;

test("the bridge: the extension host's one hub, linked to the workbench's, and every debug run's worker linked to it; other extensions only for their records", async () => {
	// (a run first, as runs_tests makes it: its worker links to the bridge, which the page hears of a report later)
	await ask("files.write", { "path": "bridged.test.mjs", "content": "import { test } from \"node:test\";\n\ntest(\"runs\", () => {});\n" });
	assert.equal((await runTests(["bridged.test.mjs"])).counts?.pass, 1);

	const linkedIn = (channels) => (one, other) => channels.some((channel) => channel.linked && ((channel.a === one && channel.b === other) || (channel.a === other && channel.b === one)));

	await session.eventually("the run's worker linked to the bridge", async () => (linkedIn(session.seen().channels)("bridge", "debug-worker") ? true : undefined), 30_000).catch(() => undefined);

	const { nodes, channels } = session.seen();
	const linked = linkedIn(channels);
	// (the hub's links: the view's other channels are what's reported on it — extensions' command calls, their workers' traffic)
	const onHub = [...new Set(channels.filter((channel) => channel.linked).flatMap((channel) => [channel.a, channel.b]))];

	assert.ok(nodes.some((node) => node.id === "bridge" && node.state === "alive"), "the bridge reports on the page: its uplink works");
	assert.ok(linked("workbench", "bridge"), JSON.stringify(onHub));
	assert.ok(linked("bridge", "debug-worker"), "a debug run's worker links to the bridge (the workspace runtime's link)");
	// (the other extensions are on the architecture view as their commands; on the hub, at most for their records —
	// observeExtension's `ext:<name>`, linked to the workbench, never the bridge — and not as hubs of their own)
	assert.deepEqual(onHub.filter((id) => ["tsval", "history", "source-control"].includes(id) || id.startsWith("exthost")), []);
	assert.ok(channels.filter((channel) => channel.linked && (channel.a.startsWith("ext:") || channel.b.startsWith("ext:"))).every((channel) => [channel.a, channel.b].includes("workbench")), "an extension's records link to the workbench");
});
