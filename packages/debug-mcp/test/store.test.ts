import * as assert from "node:assert/strict";
import { test } from "node:test";

import type { HubLogRecord } from "../src/store.ts";
import { RecordStore } from "../src/store.ts";

function rec(partial: Partial<HubLogRecord> & { "source"?: string }): HubLogRecord {
	const { source, ...rest } = partial;

	return {
		"kind": "log",
		"level": "info",
		"message": "msg",
		"time": Date.now(),
		"depth": 0,
		"context": source === undefined ? {} : { "source": source },
		...rest
	};
}

test("queryLogs filters by source, level, and text", () => {
	const store = new RecordStore();

	store.add(rec({ "source": "sw", "message": "cdn hit" }));
	store.add(rec({ "source": "workbench", "message": "monaco booted" }));
	store.add(rec({ "source": "sw", "level": "error", "message": "cdn miss" }));

	assert.equal(store.queryLogs({ "source": "sw" }).length, 2);
	assert.equal(store.queryLogs({ "minLevel": "error" }).length, 1);
	assert.deepEqual(store.queryLogs({ "textIncludes": "monaco" }).map((record) => record.source), ["workbench"]);
});

test("queryLogs honors the limit, returning the most recent", () => {
	const store = new RecordStore();

	for (let index = 0; index < 10; index += 1) {
		store.add(rec({ "source": "a", "message": "m" + index }));
	}

	const rows = store.queryLogs({ "limit": 3 });

	assert.deepEqual(rows.map((record) => record.message), ["m7", "m8", "m9"]);
});

test("querySpans pairs opens with closes and flags still-open spans", () => {
	const store = new RecordStore();
	const now = Date.now();

	// A completed span.
	store.add(rec({ "source": "debug-worker", "kind": "span-open", "span": "step", "spanId": "aa", "time": now }));
	store.add(rec({ "source": "debug-worker", "kind": "span-close", "span": "step", "spanId": "aa", "time": now + 5, "durationMs": 5 }));
	// An open span (paused at a breakpoint).
	store.add(rec({ "source": "debug-worker", "kind": "span-open", "span": "step", "spanId": "bb", "time": now }));

	const all = store.querySpans({ "source": "debug-worker" });
	assert.equal(all.length, 2);

	const closed = all.find((row) => row.spanId === "aa");
	assert.equal(closed?.open, false);
	assert.equal(closed?.durationMs, 5);

	const open = store.querySpans({ "onlyOpen": true });
	assert.deepEqual(open.map((row) => row.spanId), ["bb"]);
});

test("treeState reports sources, last message, and open spans", () => {
	const store = new RecordStore();

	store.add(rec({ "source": "sw", "message": "one" }));
	store.add(rec({ "source": "sw", "message": "two" }));
	store.add(rec({ "source": "pod", "kind": "span-open", "span": "boot", "spanId": "x1" }));

	const state = store.treeState(2);

	assert.equal(state.links, 2);
	assert.equal(state.totalRecords, 3);

	const sw = state.sources.find((entry) => entry.source === "sw");
	assert.equal(sw?.records, 2);
	assert.equal(sw?.lastMessage, "two");

	assert.deepEqual(state.openSpans.map((span) => span.name), ["boot"]);
});

test("waitFor resolves on a matching record and times out otherwise", async () => {
	const store = new RecordStore();

	const pending = store.waitFor({ "source": "debug-worker", "textIncludes": "rendered" });

	store.add(rec({ "source": "sw", "message": "rendered" })); // wrong source — ignored
	store.add(rec({ "source": "debug-worker", "message": "component rendered" }));

	const hit = await pending;
	assert.equal(hit?.message, "component rendered");

	const missed = await store.waitFor({ "source": "nobody", "timeoutMs": 20 });
	assert.equal(missed, null);
});
