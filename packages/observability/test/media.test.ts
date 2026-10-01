/**
 * A medium between exactly two contexts — a BroadcastChannel only they use — is drawn as one edge between them, marked
 * with its medium: what the probes see physically (client → channel → referee) read as what it is (client ⇄ referee).
 */
import type { ArchReport, TrafficCount } from "../src/arch.ts";
import type { StoredSample } from "../src/arch-store.ts";
import * as assert from "node:assert/strict";
import { test } from "node:test";
import { ArchitectureStore } from "../src/arch-store.ts";

const CHANNEL = "channel:game.link";
const spawnChannel = { "op": "spawn" as const, "spec": { "id": CHANNEL, "role": "channel" } };

function traffic(from: string, to: string, label: string, count: number, bytes = count * 10): TrafficCount {
	return { "from": from, "to": to, "kind": "message", "label": label, "count": count, "bytes": bytes };
}

/** client and referee each see their side of the channel: what they send into it, and what they receive from it. */
function reports(): ArchReport[] {
	return [
		{ "reporter": "client", "time": Date.now(), "nodes": [spawnChannel], "traffic": [traffic("client", CHANNEL, "game.cmd", 3), traffic(CHANNEL, "client", "game.state", 5)], "samples": [{ "t": Date.now(), "from": "client", "to": CHANNEL, "kind": "message", "label": "game.cmd", "bytes": 10 }, { "t": Date.now(), "from": CHANNEL, "to": "client", "kind": "message", "label": "game.state", "bytes": 10 }] },
		{ "reporter": "referee", "time": Date.now(), "nodes": [spawnChannel], "traffic": [traffic("referee", CHANNEL, "game.state", 5), traffic(CHANNEL, "referee", "game.cmd", 3)], "samples": [{ "t": Date.now(), "from": "referee", "to": CHANNEL, "kind": "message", "label": "game.state", "bytes": 10 }] }
	];
}

test("a channel two contexts share is one edge between them, marked with the channel — counted once, from the senders", () => {
	const store = new ArchitectureStore();
	const shown: [StoredSample, string][] = [];

	store.onSample((sample, channel) => { shown.push([sample, channel.id]); });

	for (const report of reports()) {
		store.apply(report);
	}

	const channels = [...store.channels.values()];

	assert.equal(channels.length, 1);

	const [edge] = channels;

	assert.deepEqual([edge!.a, edge!.b].sort(), ["client", "referee"]);
	assert.equal(edge!.medium, CHANNEL);
	assert.equal(edge!.count, 8, "3 commands + 5 states, each counted once though both ends saw it");
	assert.equal(edge!.labels.get("game.cmd")?.count, 3);
	assert.equal(edge!.labels.get("game.state")?.count, 5);
	assert.equal(edge![edge!.a === "client" ? "forward" : "backward"], 3, "client → referee: the commands");
	assert.deepEqual([...store.media()], [[CHANNEL, ["client", "referee"]]]);

	assert.deepEqual(edge!.recent.map((sample) => sample.label), ["game.cmd", "game.state"], "the senders' sightings");

	// Each message animates once, on the edge, the way it went: only the senders' samples. (Before the referee's first
	// report, the channel had one context on it — the client's samples went to the channel then.)
	shown.length = 0;

	for (const report of reports()) {
		store.apply(report);
	}

	assert.deepEqual(shown.map(([sample, channel]) => [sample.label, channel, sample.forward === (edge!.a === "client") ? "client→" : "referee→"]), [["game.cmd", edge!.id, "client→"], ["game.state", edge!.id, "referee→"]]);

	// The channel isn't a context of its own in the picture any more.
	const snapshot = store.snapshot() as { "nodes": { "id": string }[]; "media": { "id": string; "between": string[] }[]; "channels": { "medium"?: string }[] };

	assert.ok(!snapshot.nodes.some((node) => node.id === CHANNEL));
	assert.deepEqual(snapshot.media, [{ "id": CHANNEL, "between": ["client", "referee"] }]);
	assert.equal(snapshot.channels[0]?.medium, CHANNEL);
	assert.equal(store.channelById(edge!.id)?.medium, CHANNEL);
});

test("a channel with one context on it, or three, stays a node", () => {
	const store = new ArchitectureStore();

	store.apply(reports()[0]!);
	assert.equal(store.media().size, 0, "only the client so far");
	assert.ok([...store.channels.values()].every((channel) => channel.medium === undefined));

	store.apply(reports()[1]!);
	assert.equal(store.media().size, 1);

	store.apply({ "reporter": "spectator", "time": Date.now(), "nodes": [spawnChannel], "traffic": [traffic(CHANNEL, "spectator", "game.state", 5)] });
	assert.equal(store.media().size, 0, "a third: it's a meeting place, not a wire");
	assert.equal([...store.channels.values()].filter((channel) => channel.a === CHANNEL || channel.b === CHANNEL).length, 3);
});
