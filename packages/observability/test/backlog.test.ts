import type { LogRecord } from "@brianjenkins94/util/logger";
import * as assert from "node:assert/strict";

import { after, test } from "node:test";
import { createHub, portTransport } from "@brianjenkins94/hub";
import { LOG_BACKLOG, LOG_SUBJECT, logBacklog } from "../src/index.ts";
import { elapse, until } from "./until.ts";

const record = (message: string): LogRecord => ({ "kind": "log", "level": "info", "message": message, "context": { "source": "page" }, "time": Date.now(), "depth": 0 });

/** Until `seen` holds `count` records — then a moment more, so a duplicate would be there to fail the test. */
async function arrived(seen: string[], count: number): Promise<void> {
	await until(count + " records at the collector", () => seen.length >= count);
	await elapse(20);
}

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

test("what a root logged before a collector linked reaches it once, as a backlog, and the rest live", async (t) => {
	const root = createHub({ "id": "root" });
	const backlog = logBacklog(root);

	t.after(() => { backlog.dispose(); });
	root.publish(LOG_SUBJECT + ".page", record("starting"));
	root.publish(LOG_SUBJECT + ".page", record("started"));

	const { hub, seen } = collector();

	linkPair(root, hub);
	// Logged after the link, but before the collector's interest has arrived: held too, not lost.
	root.publish(LOG_SUBJECT + ".page", record("in flight"));
	await backlog.flushWhenReady(5000);
	root.publish(LOG_SUBJECT + ".page", record("later"));
	await arrived(seen, 4);

	assert.deepEqual(seen, ["backlog starting", "backlog started", "backlog in flight", "live later"]);
});

test("the first record logged once the collector can hear flushes the backlog instead of joining it — no duplicates", async (t) => {
	const root = createHub({ "id": "root" });
	const backlog = logBacklog(root);

	t.after(() => { backlog.dispose(); });
	root.publish(LOG_SUBJECT + ".page", record("early"));

	const { hub, seen } = collector();

	linkPair(root, hub);
	assert.ok(await root.whenInterested(LOG_BACKLOG, 5000));
	// No flushWhenReady yet: this record goes out live, and flushes what was held.
	root.publish(LOG_SUBJECT + ".page", record("now"));
	await backlog.flushWhenReady(100);
	await arrived(seen, 2);

	assert.deepEqual(seen.toSorted(), ["backlog early", "live now"]);
});

test("it holds at most `max` (the newest), and holds again after the collector goes, for the next one", async (t) => {
	const root = createHub({ "id": "root" });
	const backlog = logBacklog(root, { "max": 2 });

	t.after(() => { backlog.dispose(); });
	for (const message of ["a", "b", "c"]) {
		root.publish(LOG_SUBJECT + ".page", record(message));
	}

	const first = collector();
	const unlink = linkPair(root, first.hub);

	await backlog.flushWhenReady(5000);
	await arrived(first.seen, 2);
	assert.deepEqual(first.seen, ["backlog b", "backlog c"]);

	unlink();
	backlog.rearm();
	root.publish(LOG_SUBJECT + ".page", record("while away"));

	const second = collector();

	linkPair(root, second.hub);
	await backlog.flushWhenReady(5000);
	await arrived(second.seen, 1);
	assert.deepEqual(second.seen, ["backlog while away"]);
});

test("with nobody to send it to, flushWhenReady gives up and keeps holding", async (t) => {
	const root = createHub({ "id": "root" });
	const backlog = logBacklog(root);

	t.after(() => { backlog.dispose(); });
	root.publish(LOG_SUBJECT + ".page", record("held"));
	await backlog.flushWhenReady(50);

	const { hub, seen } = collector();

	linkPair(root, hub);
	await backlog.flushWhenReady(5000);
	await arrived(seen, 1);
	assert.deepEqual(seen, ["backlog held"]);
});
