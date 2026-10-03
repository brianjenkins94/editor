import * as assert from "node:assert/strict";

import { test } from "node:test";
import { createHub } from "@brianjenkins94/hub";
import type { MetricsSample } from "../src/metrics.ts";
import { durationGauge, meteredDataChannel, METRICS_SUBJECT, MetricsHistory, reportMetrics, spanMetrics } from "../src/metrics.ts";
import { elapse, until } from "./until.ts";

test("a reporter publishes each gauge's reading on $sys.metrics under its source, a group's as name.key", async (t) => {
	const hub = createHub({ "id": "page" });
	const seen: MetricsSample[] = [];

	hub.subscribe(METRICS_SUBJECT + ".>", (data) => { seen.push(data as MetricsSample); });

	const metrics = reportMetrics(hub, { "intervalMs": 20 });
	let n = 0;

	t.after(() => { metrics.dispose(); });
	metrics.gauge("count", () => (n += 1));
	metrics.gauge("memory", () => ({ "total": 3, "workbench": 2 }));
	await until("two samples", () => seen.length >= 2);

	assert.ok(seen.length >= 2, "sampled on the interval");
	assert.equal(seen[0].source, "page");
	assert.deepEqual(Object.keys(seen[0].values).sort(), ["count", "memory.total", "memory.workbench"]);
	assert.ok(seen[1].values["count"] > seen[0].values["count"], "each sample reads the gauge again");
});

test("a gauge with no reading, or one that throws, is left out of that sample; an empty reading isn't published", async () => {
	const hub = createHub({ "id": "page" });
	const seen: MetricsSample[] = [];

	hub.subscribe(METRICS_SUBJECT + ".>", (data) => { seen.push(data as MetricsSample); });

	const metrics = reportMetrics(hub, { "source": "shell", "intervalMs": 20 });

	await elapse(50); // two and a half intervals: nothing to publish, so nothing published
	assert.equal(seen.length, 0, "no gauges, no samples");

	metrics.gauge("later", () => undefined);
	metrics.gauge("broken", () => { throw new Error("no"); });

	const remove = metrics.gauge("fine", () => 1);

	assert.deepEqual(metrics.sample().values, { "fine": 1 });
	remove();
	assert.deepEqual(metrics.sample().values, {});
	assert.equal(metrics.sample().source, "shell");
	seen.length = 0;
	await elapse(50); // two and a half intervals: nothing to publish, so nothing published
	assert.equal(seen.length, 0, "gauges with nothing to report: no samples");
	metrics.dispose();
});

test("history keeps the last samples per source and summarizes each series over a window", () => {
	const history = new MetricsHistory(3);
	const now = 100_000;

	for (let i = 0; i < 5; i++) {
		history.add({ "source": "workbench", "t": now - 4000 + i * 1000, "values": { "memory.total": 10 + i, "longFrames": i % 2 } });
	}

	history.add({ "source": "shell", "t": now, "values": { "longFrames": 7 } });
	history.add({ "not": "a sample" });

	assert.equal(history.read()["workbench"].length, 3, "only the last `keep` per source");
	assert.deepEqual(history.read(now - 1500)["workbench"].map((sample) => sample.t), [now - 1000, now]);

	const memory = history.summarize({ "match": "MEMORY", "now": now, "points": 2 });

	assert.deepEqual(memory.map((series) => series.series), ["workbench:memory.total"]);
	assert.deepEqual({ ...memory[0], "points": undefined }, { "series": "workbench:memory.total", "latest": 14, "agoMs": 0, "min": 12, "max": 14, "mean": 13, "samples": 3, "points": undefined });
	assert.deepEqual(memory[0].points, [[2000, 12], [0, 14]], "thinned, keeping the latest");
	assert.deepEqual(history.summarize({ "source": "shell", "now": now }).map((series) => series.series), ["shell:longFrames"]);
	assert.equal(history.summarize({ "sinceMs": 500, "now": now }).length, 3, "only readings inside the window");
});

test("span metrics: rate, errors, p50/p95 and open per source/name, from the records alone", () => {
	const spans = spanMetrics({ "windowMs": 10000 });
	const record = (kind: string, spanId: string, extra: Record<string, unknown> = {}) => spans.record({ "kind": kind, "level": kind === "span-open" ? "trace" : "info", "span": "cdn", "spanId": spanId, "context": { "source": "sw" }, ...extra });

	assert.equal(spans.gauge(), undefined, "nothing to report yet");

	for (let i = 0; i < 10; i++) {
		record("span-open", "s" + i);
		record("span-close", "s" + i, { "durationMs": (i + 1) * 10 });
	}

	record("span-open", "bad");
	record("log", "bad", { "level": "error", "message": "cdn failed" });
	record("span-close", "bad", { "durationMs": 500 });
	record("span-open", "hung");
	spans.record({ "kind": "span-open", "level": "trace", "span": "ata", "spanId": "a1", "context": { "source": "workbench" } });

	const values = spans.gauge() as Record<string, number>;

	assert.equal(values["sw/cdn.rate"], 1.1, "11 ended in a 10 s window");
	assert.equal(values["sw/cdn.errors"], 1, "the one with an error logged inside it");
	assert.equal(values["sw/cdn.p50"], 60);
	assert.equal(values["sw/cdn.p95"], 500);
	assert.equal(values["sw/cdn.open"], 1, "the one still running");
	assert.equal(values["workbench/ata.open"], 1);
	assert.equal(values["workbench/ata.rate"], undefined, "none of it has ended");
});

test("durationGauge reads the mean and max of what it recorded since the last reading — nothing if nothing ran", () => {
	const tick = durationGauge();

	assert.equal(tick.gauge(), undefined);
	tick.record(2);
	tick.record(6);
	assert.deepEqual(tick.gauge(), { "mean": 4, "max": 6 });
	assert.equal(tick.gauge(), undefined, "each reading starts afresh");
});

test("meteredDataChannel weighs what its transport sent and what the channel received, without touching the channel's send", () => {
	class Channel extends EventTarget {
		public readyState: RTCDataChannelState = "open";
		public bufferedAmount = 0;
		public send(data: string): void { this.bufferedAmount += data.length; }
	}

	const channel = new Channel();
	const send = channel.send;
	const { transport, gauge } = meteredDataChannel(channel as unknown as RTCDataChannel);

	transport.send({ "subject": "game.state", "data": "x".repeat(1000) });
	channel.dispatchEvent(Object.assign(new Event("message"), { "data": "y".repeat(2048) }));

	const rates = gauge() as { "in": number; "out": number };

	assert.equal(channel.send, send);
	assert.ok(rates.out > 0 && rates.in > 0, "both ways");
	assert.ok(rates.in > rates.out, "in proportion: 2 KB in, about 1 KB out");
});
