/**
 * script_run's answer bounded (workbench/script-run.ts): a value whole, or as much of its JSON as fits, saying how much
 * there was; a log's first lines, each cut to length. The realm itself runs in the browser (architecture-tour-tools.mjs).
 *
 *   node --import tsx --test test/script-run.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { bounded, boundedLogs } = await import("../workbench/script-run.ts");

test("a value: whole while its JSON fits, else its first characters and how many there were", () => {
	assert.deepEqual(bounded({ "total": 5 }), { "value": { "total": 5 } });
	assert.deepEqual(bounded(undefined), { "value": undefined });

	const big = bounded("x".repeat(200_000));

	assert.equal(big.value, undefined);
	assert.equal(big.valueText.length, 100_000);
	assert.deepEqual(big.truncated, { "chars": 200_002, "shown": 100_000 });
});

test("a log: its first 500 lines, a long one cut, and how many were left out", () => {
	assert.deepEqual(boundedLogs(["a", "b"]), { "logs": ["a", "b"] });

	const many = boundedLogs([..."y".repeat(600)].map((_, index) => (index === 0 ? "z".repeat(3000) : String(index))));

	assert.equal(many.logs.length, 500);
	assert.equal(many.logsLeftOut, 100);
	assert.match(many.logs[0], /^z{2000}… \(3000 characters\)$/u);
});
