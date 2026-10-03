// A JS Self-Profiling trace as a .cpuprofile (cpuprofile.ts), and where its time went.
import * as assert from "node:assert/strict";
import { test } from "node:test";

import { summarize, toCpuProfile } from "../cpuprofile.ts";

// main → render → draw, and main → idle: samples every 10 ms.
const trace = {
	"resources": ["http://localhost/app.js"],
	"frames": [
		{ "name": "main", "resourceId": 0, "line": 1, "column": 1 },
		{ "name": "render", "resourceId": 0, "line": 10, "column": 3 },
		{ "name": "draw", "resourceId": 0, "line": 20, "column": 5 },
		{ "name": "", "resourceId": 0, "line": 30, "column": 1 }
	],
	"stacks": [
		{ "frameId": 0 },
		{ "frameId": 1, "parentId": 0 },
		{ "frameId": 2, "parentId": 1 },
		{ "frameId": 3, "parentId": 0 }
	],
	"samples": [
		{ "timestamp": 100, "stackId": 2 },
		{ "timestamp": 110, "stackId": 2 },
		{ "timestamp": 120, "stackId": 1 },
		{ "timestamp": 130 },
		{ "timestamp": 140, "stackId": 3 },
		{ "timestamp": 150, "stackId": 2 }
	]
};

test("a trace becomes a call tree: one node per frame under its caller, each sample on its stack's node", () => {
	const profile = toCpuProfile(trace);
	const named = (name) => profile.nodes.filter((node) => node.callFrame.functionName === name);

	assert.deepEqual(named("main").length, 1, "main once, however many stacks pass through it");
	assert.equal(named("draw")[0].hitCount, 3);
	assert.equal(named("render")[0].hitCount, 1);
	assert.equal(named("(idle)")[0].hitCount, 1, "a sample with no stack is idle");
	assert.equal(named("(anonymous)").length, 1, "a nameless frame is anonymous");
	assert.deepEqual(named("render")[0].children, [named("draw")[0].id]);
	assert.deepEqual(named("draw")[0].callFrame, { "functionName": "draw", "scriptId": "0", "url": "http://localhost/app.js", "lineNumber": 19, "columnNumber": 4 }, "lines and columns from 0");
	assert.deepEqual([profile.startTime, profile.endTime], [100_000, 150_000], "microseconds");
	assert.deepEqual(profile.timeDeltas, [0, 10_000, 10_000, 10_000, 10_000, 10_000]);
	assert.equal(profile.samples.length, 6);
});

test("a summary: self time and total time by function, busiest first, idle apart", () => {
	const summary = summarize(toCpuProfile(trace));

	assert.equal(summary.durationMs, 50);
	assert.equal(summary.idleMs, 10);
	assert.deepEqual(summary.functions.map((entry) => [entry.function, entry.selfMs, entry.totalMs]), [
		["draw", 30, 30],
		["render", 10, 40],
		["(anonymous)", 10, 10]
	]);
	assert.equal(summary.functions[0].line, 20, "the line as the source has it");
	assert.equal(summary.functions[0].column, 5, "and the column");
	assert.equal(summarize(toCpuProfile(trace), 1).functions.length, 1, "the top N");
});
