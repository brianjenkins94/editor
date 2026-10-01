import * as assert from "node:assert/strict";

import { test } from "node:test";
import { createHub } from "@brianjenkins94/hub";
import type { MetricsSample } from "../src/metrics.ts";
import { METRICS_SUBJECT, reportMetrics } from "../src/metrics.ts";

test("a reporter publishes each gauge's reading on $sys.metrics under its source, a group's as name.key", async () => {
	const hub = createHub({ "id": "page" });
	const seen: MetricsSample[] = [];

	hub.subscribe(METRICS_SUBJECT + ".>", (data) => { seen.push(data as MetricsSample); });

	const metrics = reportMetrics(hub, { "intervalMs": 20 });
	let n = 0;

	metrics.gauge("count", () => (n += 1));
	metrics.gauge("memory", () => ({ "total": 3, "workbench": 2 }));
	await new Promise((resolve) => { setTimeout(resolve, 70); });
	metrics.dispose();

	assert.ok(seen.length >= 2, "sampled on the interval");
	assert.equal(seen[0].source, "page");
	assert.deepEqual(Object.keys(seen[0].values).sort(), ["count", "memory.total", "memory.workbench"]);
	assert.ok(seen[1].values["count"] > seen[0].values["count"], "each sample reads the gauge again");
});

test("a gauge with no reading, or one that throws, is left out of that sample; nothing is published without gauges", async () => {
	const hub = createHub({ "id": "page" });
	const seen: MetricsSample[] = [];

	hub.subscribe(METRICS_SUBJECT + ".>", (data) => { seen.push(data as MetricsSample); });

	const metrics = reportMetrics(hub, { "source": "shell", "intervalMs": 20 });

	await new Promise((resolve) => { setTimeout(resolve, 50); });
	assert.equal(seen.length, 0, "no gauges, no samples");

	metrics.gauge("later", () => undefined);
	metrics.gauge("broken", () => { throw new Error("no"); });

	const remove = metrics.gauge("fine", () => 1);

	assert.deepEqual(metrics.sample().values, { "fine": 1 });
	remove();
	assert.deepEqual(metrics.sample().values, {});
	assert.equal(metrics.sample().source, "shell");
	metrics.dispose();
});
