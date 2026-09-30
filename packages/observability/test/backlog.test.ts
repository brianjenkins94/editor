import type { LogRecord } from "@brianjenkins94/util/logger";
import * as assert from "node:assert/strict";

import { after, test } from "node:test";
import { createHub, portTransport } from "@brianjenkins94/hub";
import { LOG_BACKLOG, LOG_SUBJECT, logBacklog } from "../src/index.ts";

const record = (message: string): LogRecord => ({ "kind": "log", "level": "info", "message": message, "context": { "source": "page" }, "time": Date.now(), "depth": 0 });
const settle = async (): Promise<void> => { await new Promise((resolve) => { setTimeout(resolve, 20); }); };

/** A collector (debug-mcp's shape): every record, live or from a backlog, in arrival order. */
function collector() {
	const hub = createHub({ "id": "collector" });
	const seen: string[] = [];

	hub.subscribe(LOG_SUBJECT + ".>", (data) => { seen.push("live " + (data as LogRecord).message); });
	hub.subscribe(LOG_BACKLOG, (data) => {
		for (const held of data as LogRecord[]) {
			seen.push("backlog " + held.message);
		}
	});

	return { "hub": hub, "seen": seen };
}

const channels: MessageChannel[] = [];

// Open ports keep the process alive.
after(() => {
	for (const { port1, port2 } of channels) {
		port1.close();
		port2.close();
	}
});

function linkPair(root: ReturnType<typeof createHub>, other: ReturnType<typeof createHub>): () => void {
	const channel = new MessageChannel();

	channels.push(channel);
	const unlinkRoot = root.link(portTransport(channel.port1));
	const unlinkOther = other.link(portTransport(channel.port2));

	return () => {
		unlinkRoot();
		unlinkOther();
	};
}

test("what a root logged before a collector linked reaches it once, as a backlog, and the rest live", async () => {
	const root = createHub({ "id": "root" });
	const backlog = logBacklog(root);

	root.publish(LOG_SUBJECT + ".page", record("starting"));
	root.publish(LOG_SUBJECT + ".page", record("started"));

	const { hub, seen } = collector();

	linkPair(root, hub);
	// Logged after the link, but before the collector's interest has arrived: held too, not lost.
	root.publish(LOG_SUBJECT + ".page", record("in flight"));
	await backlog.flushWhenReady(1000);
	root.publish(LOG_SUBJECT + ".page", record("later"));
	await settle();

	assert.deepEqual(seen, ["backlog starting", "backlog started", "backlog in flight", "live later"]);
	backlog.dispose();
});

test("the first record logged once the collector can hear flushes the backlog instead of joining it — no duplicates", async () => {
	const root = createHub({ "id": "root" });
	const backlog = logBacklog(root);

	root.publish(LOG_SUBJECT + ".page", record("early"));

	const { hub, seen } = collector();

	linkPair(root, hub);
	await root.whenInterested(LOG_BACKLOG, 1000);
	// No flushWhenReady yet: this record goes out live, and flushes what was held.
	root.publish(LOG_SUBJECT + ".page", record("now"));
	await backlog.flushWhenReady(100);
	await settle();

	assert.deepEqual(seen.toSorted(), ["backlog early", "live now"]);
	backlog.dispose();
});

test("it holds at most `max` (the newest), and holds again after the collector goes, for the next one", async () => {
	const root = createHub({ "id": "root" });
	const backlog = logBacklog(root, { "max": 2 });

	for (const message of ["a", "b", "c"]) {
		root.publish(LOG_SUBJECT + ".page", record(message));
	}

	const first = collector();
	const unlink = linkPair(root, first.hub);

	await backlog.flushWhenReady(1000);
	await settle();
	assert.deepEqual(first.seen, ["backlog b", "backlog c"]);

	unlink();
	backlog.rearm();
	root.publish(LOG_SUBJECT + ".page", record("while away"));

	const second = collector();

	linkPair(root, second.hub);
	await backlog.flushWhenReady(1000);
	await settle();
	assert.deepEqual(second.seen, ["backlog while away"]);
	backlog.dispose();
});

test("with nobody to send it to, flushWhenReady gives up and keeps holding", async () => {
	const root = createHub({ "id": "root" });
	const backlog = logBacklog(root);

	root.publish(LOG_SUBJECT + ".page", record("held"));
	await backlog.flushWhenReady(50);

	const { hub, seen } = collector();

	linkPair(root, hub);
	await backlog.flushWhenReady(1000);
	await settle();
	assert.deepEqual(seen, ["backlog held"]);
	backlog.dispose();
});
