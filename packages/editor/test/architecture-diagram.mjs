/**
 * ARCHITECTURE.md's diagram is the tour's (DISCOVERED-ARCHITECTURE.md): rendered from what the tour's shards saw together
 * (architecture-tour-*.mjs, each keeping its session's in $TMPDIR/architecture-tour-seen/). Run after them. A local run
 * rewrites the block — a change to the editor shows up as a change to it, to commit with the change; in CI (the
 * architecture workflow, once its shards' are downloaded) a block that differs from a fresh tour's fails.
 *
 *   node --test test/architecture-diagram.mjs
 */
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import * as path from "node:path";
import { test } from "node:test";

import { SEEN_DIR } from "./architecture-tour-session.mjs";

const { tourDiagram } = await import("../shared/architecture-model.ts");

/** What the shards saw, as one session would have: every node (alive if it was alive in any), every channel (its
 *  messages' counts added up), every hub's subscriptions. */
function together(seen) {
	const nodes = new Map();
	const channels = new Map();
	const topology = {};

	for (const each of seen) {
		for (const node of each.nodes) {
			const known = nodes.get(node.id);

			nodes.set(node.id, known === undefined || (known.state !== "alive" && node.state === "alive") ? node : known);
		}

		for (const channel of each.channels) {
			const key = [channel.a, channel.b, channel.medium ?? ""].join("\0");
			const known = channels.get(key);

			if (known === undefined) {
				channels.set(key, { ...channel, "labels": { ...channel.labels } });
			} else {
				for (const [label, stats] of Object.entries(channel.labels)) {
					known.labels[label] = { ...stats, "count": (known.labels[label]?.count ?? 0) + stats.count };
				}
			}
		}

		for (const [hub, { subscriptions }] of Object.entries(each.topology)) {
			topology[hub] = { "subscriptions": [...new Set([...topology[hub]?.subscriptions ?? [], ...subscriptions])] };
		}
	}

	return { "nodes": [...nodes.values()], "channels": [...channels.values()], "topology": topology };
}

test("the diagram: ARCHITECTURE.md's is the tour's", async () => {
	// Every shard's, or the diagram would be drawn from part of the tour.
	const shards = (await readdir(new URL(".", import.meta.url))).filter((name) => /^architecture-tour-.+\.mjs$/u.test(name) && name !== "architecture-tour-session.mjs").map((name) => name.replace(/\.mjs$/u, ".json"));
	const files = (await readdir(SEEN_DIR).catch(() => [])).filter((name) => shards.includes(name));

	assert.deepEqual(files.toSorted(), shards.toSorted(), `what every shard of the tour saw, in ${SEEN_DIR}: run them all (architecture-tour-*.mjs) first`);

	// (in order, so a run here and one in CI draw the same)
	const seen = await Promise.all(files.toSorted().map(async (name) => JSON.parse(await readFile(path.join(SEEN_DIR, name), "utf8"))));
	const file = new URL("../ARCHITECTURE.md", import.meta.url);
	const doc = await readFile(file, "utf8");
	const [begin, end] = ["<!-- architecture-tour:begin -->\n", "\n<!-- architecture-tour:end -->"];
	const committed = doc.slice(doc.indexOf(begin) + begin.length, doc.indexOf(end));
	const fresh = tourDiagram(together(seen));

	if (process.env.CI === undefined) {
		if (fresh !== committed) {
			await writeFile(file, doc.replace(begin + committed + end, begin + fresh + end));
			console.log("ARCHITECTURE.md: the tour's diagram changed — rewritten; commit it with the change");
		}
	} else {
		const [now, then] = [fresh.split("\n"), committed.split("\n")];
		const changes = [...then.filter((line) => !now.includes(line)).map((line) => "- " + line), ...now.filter((line) => !then.includes(line)).map((line) => "+ " + line)];

		assert.deepEqual(changes, [], "ARCHITECTURE.md's diagram isn't this tour's: run the tour locally, which rewrites it, and commit it");
	}
});
