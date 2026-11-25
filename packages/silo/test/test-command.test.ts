/**
 * `silo test`'s reading back (src/test.ts): what silo's reporter wrote in a CI's log, as each test's outcome, each
 * test's standing by its file and titles, the job's name off, and the vouches made and agreed on. What needs real git
 * is test-command-git.test.ts's.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { CiRun } from "@brianjenkins94/util/silo/outcomes";
import { logRead, reportedIn, standingsByTest, standingsText } from "../src/test.ts";

test("silo's reporter's lines in a log, timestamps, pnpm's prefix and all: each test its file first, the rest of the log left", () => {
	const log = [
		"2026-11-22T18:00:00.0000000Z ✔ adds (0.3ms)",
		"2026-11-22T18:00:00.0000001Z silo:test {\"file\":\"packages/editor/test/add.test.mjs\",\"titles\":[\"adds\"],\"outcome\":\"pass\",\"ms\":0.3}",
		"2026-11-22T18:00:00.0000002Z packages/editor test: silo:test {\"file\":\"packages/editor/test/add.test.mjs\",\"titles\":[\"a suite\",\"fails\"],\"outcome\":\"fail\"}",
		"silo:test {not json",
		"silo:test {\"titles\":[\"no file\"],\"outcome\":\"pass\"}"
	].join("\n");

	assert.deepEqual(reportedIn(log), [
		{ "titles": ["packages/editor/test/add.test.mjs", "adds"], "outcome": "pass", "ms": 0.3 },
		{ "titles": ["packages/editor/test/add.test.mjs", "a suite", "fails"], "outcome": "fail" }
	]);
});

test("a test's standing over CI's runs, by its file and titles: the job's name off", () => {
	const run = (id: string, outcome: "pass" | "fail", at: string) => ({ "id": id, "commit": id, "at": at, "attempts": [{ "attempt": 1, "jobs": [{ "name": "build-lint (test)", "conclusion": "success", "tests": [{ "titles": ["packages/editor/test/add.test.mjs", "adds"], "outcome": outcome }] }] }] });
	const known = standingsByTest([run("2", "pass", "2026-11-22T10:00:00Z"), run("1", "fail", "2026-11-21T10:00:00Z")]);
	const standing = known.get("packages/editor/test/add.test.mjs › adds");

	assert.deepEqual([...known.keys()], ["packages/editor/test/add.test.mjs › adds"]);
	assert.equal(standing?.runs, 2);
	assert.equal(standing?.last.verdict, "pass");
	assert.equal(standing?.lastFailed?.verdict, "fail");
});

const ADD = "packages/editor/test/add.test.mjs";

/** CI's `n`th run, as it's read back: `log`, or none when the job failed before its tests. */
const runOf = (n: number, log: string): CiRun => ({ "id": String(n), "commit": `c${String(n)}`, "at": new Date(Date.UTC(2026, 10, 1) + n * 3_600_000).toISOString(), "attempts": [{ "attempt": 1, "jobs": [{ "name": "build-lint (test)", "conclusion": "success", "tests": logRead(log) }] }] });
const reported = (title: string, outcome = "pass"): string => `2026-11-22T18:00:00.0Z packages/editor test: silo:test ${JSON.stringify({ "file": ADD, "titles": [title], "outcome": outcome })}\n`;

/** CI run `pushes` times, reading back its last `window` as each run starts: which of them ran the test. */
async function pushed(pushes: number, window: number, failsToStart: (n: number) => boolean = () => false): Promise<boolean[]> {
	const { selectTests } = await import("@brianjenkins94/util/silo/select");
	const runs: CiRun[] = [];

	return Array.from({ "length": pushes }, (_, n) => {
		if (failsToStart(n)) {
			runs.push(runOf(n, ""));

			return false;
		}

		const known = standingsByTest(runs.slice(-window));
		const id = `${ADD} › adds`;
		const selected = selectTests({ "tests": [{ "id": id, "file": ADD }], "reach": () => new Set(["add.mjs#add"]), "changed": new Set(["other.mjs#other"]), "fingerprints": new Map(), "standings": known, "vouches": [], "runtime": "node", "now": Date.UTC(2026, 10, 1) + n * 3_600_000 });
		const carried = standingsText(selected.map((each) => ({ ...each, ...known.has(each.id) ? { "standing": known.get(each.id)! } : {} })));

		runs.push(runOf(n, carried + (selected[0]!.run ? reported("adds") : "")));

		return selected[0]!.run;
	});
}

test("a test that has rested goes on resting, past the runs read back, and one that failed to start doesn't wake it", async () => {
	const ran = await pushed(80, 20);

	assert.equal(ran.slice(0, 20).every(Boolean), true);
	assert.equal(ran.slice(20).some(Boolean), false);

	// (runs whose job failed before any test, now and then: no pass, and no failure of the test's)
	const some = await pushed(80, 20, (n) => n % 7 === 3);

	assert.equal(some.slice(0, 24).filter(Boolean).length, 20);
	assert.equal(some.slice(24).some(Boolean), false);
});

test("a carried standing goes on with what its own run and the later ones did: a failure ends its streak, a rename the test", () => {
	const carried = standingsText([{ "id": `${ADD} › adds`, "file": ADD, "run": true, "why": "not reached", "standing": { "id": `${ADD} › adds`, "runs": 30, "last": { "verdict": "pass", "run": "0", "commit": "c", "at": "2026-11-01T00:00:00.000Z" }, "flakes": 0, "streak": { "verdict": "pass", "runs": 25 } } }]);
	const known = (runs: CiRun[]) => standingsByTest(runs).get(`${ADD} › adds`);

	assert.deepEqual(known([runOf(1, carried)])?.streak, { "verdict": "pass", "runs": 25 });
	assert.deepEqual(known([runOf(1, carried + reported("adds")), runOf(2, reported("adds"))])?.streak, { "verdict": "pass", "runs": 27 });

	const failed = known([runOf(1, carried + reported("adds", "fail")), runOf(2, reported("adds"))]);

	assert.deepEqual(failed?.streak, { "verdict": "pass", "runs": 1 });
	assert.equal(failed?.lastFailed?.run, "1");
	assert.equal(failed?.runs, 32);
	assert.equal(known([runOf(0, reported("adds")), runOf(1, carried + reported("sums"))]), undefined);
	assert.equal(known([runOf(1, carried + reported("sums")), runOf(2, reported("adds"))])?.streak.runs, 1);
});

test("a pass vouched for with what its file reaches, as fingerprinted now; a failure vouches for nothing", async () => {
	const { vouchesFor } = await import("../src/test.ts");
	const { digest } = await import("@brianjenkins94/util/silo/graph");
	const edges: Record<string, string[]> = { "a.test.mjs#(top)": ["a.mjs#a"] };
	const graph = { "fingerprints": new Map([["a.test.mjs#(top)", "t"], ["a.mjs#a", "f1"], ["b.mjs#b", "f2"]]), "nodes": () => Object.keys(edges), "edges": (id: string) => edges[id] ?? [] };
	const made = vouchesFor([{ "titles": ["a.test.mjs", "adds"], "outcome": "pass" }, { "titles": ["a.test.mjs", "fails"], "outcome": "fail" }], graph, { "by": "brian", "runtime": "node", "at": "2026-11-22T18:00:00.000Z" });

	assert.deepEqual(made, [{ "test": "a.test.mjs › adds", "outcome": "pass", "by": "brian", "at": "2026-11-22T18:00:00.000Z", "runtime": "node", "reached": { "a.test.mjs#(top)": digest("t"), "a.mjs#a": digest("f1") } }]);
});

test("another runtime's vouch counts for a test CI passed after it was made (decision 19), not before, nor one CI failed", async () => {
	const { agreedOn } = await import("../src/test.ts");
	const standing = (id: string, verdict: "pass" | "fail", at: string) => [id, { "id": id, "runs": 3, "last": { "verdict": verdict, "run": "1", "commit": "c", "at": at }, "flakes": 0, "streak": { "verdict": verdict, "runs": 3 } }] as const;
	const vouch = (test: string, at: string, runtime = "tsval") => ({ "test": test, "outcome": "pass" as const, "by": "brian", "at": at, "runtime": runtime, "reached": {} });
	const standings = new Map([standing("a", "pass", "2026-11-22T12:00:00Z"), standing("b", "pass", "2026-11-22T12:00:00Z"), standing("c", "fail", "2026-11-22T12:00:00Z"), standing("d", "pass", "2026-11-22T12:00:00Z")]);

	assert.deepEqual([...agreedOn([vouch("a", "2026-11-22T11:00:00Z"), vouch("b", "2026-11-22T13:00:00Z"), vouch("c", "2026-11-22T11:00:00Z"), vouch("d", "2026-11-22T11:00:00Z", "node"), vouch("e", "2026-11-22T11:00:00Z")], standings, "node")], ["a"]);
});
