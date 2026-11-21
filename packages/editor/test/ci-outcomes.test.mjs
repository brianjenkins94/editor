/**
 * How each test has come out in CI (workbench/ci-outcomes.ts): a branch's runs of each workflow, every attempt's jobs and
 * the tests their logs reported, a finished job's kept so it isn't asked again, a workflow that runs no tests left after a
 * few runs; and each test's standing joined to the test file it's of. The shell's answers are made up here.
 *
 *   node --import tsx --test test/ci-outcomes.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { standings } from "@brianjenkins94/util/silo/outcomes";

const { ciRuns, fileOf, testsInLog, titlesOf } = await import("../workbench/ci-outcomes.ts");

const REPOSITORY = "octo/hello";

/** A spec reporter's line in a CI log, coloured as node:test colours it. */
const line = (mark, title) => `2026-11-20T00:00:00.0000000Z \u001B[32m${mark} ${title} (12.5ms)\u001B[39m`;

/** The shell, as ci-outcomes asks it: `runs` of the branch, newest first, each { id, name, jobs: [{ id, name, attempt, log }] }. */
function shellOf(runs) {
	const asked = [];
	const ask = async (request) => {
		asked.push(request);

		if (request.job !== undefined) {
			const job = runs.flatMap((run) => run.jobs).find((each) => each.id === request.job);

			return { "signedIn": true, "log": job.log };
		}

		if (request.run !== undefined) {
			assert.equal(request.attempts, true);

			return {
				"signedIn": true,
				"jobs": runs.find((run) => run.id === request.run).jobs.map((job) => ({
					"id": job.id,
					"name": job.name,
					"status": "completed",
					"conclusion": "success",
					"run_attempt": job.attempt ?? 1
				}))
			};
		}

		return {
			"signedIn": true,
			"workflow_runs": runs.map((run, index) => ({
				"id": run.id,
				"name": run.name,
				"status": "completed",
				"head_branch": run.branch ?? "main",
				"head_sha": `${String(run.id)}`.padEnd(40, "0"),
				"created_at": `2026-11-${String(20 - index).padStart(2, "0")}T00:00:00Z`
			}))
		};
	};

	return { "ask": ask, "asked": asked };
}

test("a branch's runs: every attempt's jobs, a test that failed then passed on the rerun flaked, which ends a streak of passes", async () => {
	const { ask } = shellOf([
		{
			"id": 3,
			"name": "architecture",
			"jobs": [
				{
					"id": 30,
					"name": "specs-1",
					"log": [
						line("✔", "a.spec.mjs"),
						line("✔", "b.spec.mjs")
					].join("\n")
				}
			]
		},
		{
			"id": 2,
			"name": "architecture",
			"jobs": [
				{
					"id": 20,
					"name": "specs-1",
					"attempt": 1,
					"log": [
						line("✖", "a.spec.mjs"),
						line("✔", "b.spec.mjs")
					].join("\n")
				},
				{
					"id": 21,
					"name": "specs-1",
					"attempt": 2,
					"log": [
						line("✔", "a.spec.mjs"),
						line("✔", "b.spec.mjs")
					].join("\n")
				}
			]
		},
		{
			"id": 1,
			"name": "architecture",
			"jobs": [
				{
					"id": 10,
					"name": "specs-1",
					"log": [
						line("✔", "a.spec.mjs"),
						line("✖", "b.spec.mjs")
					].join("\n")
				}
			]
		},
		{
			"id": 9,
			"name": "architecture",
			"branch": "elsewhere",
			"jobs": []
		}
	]);
	const read = await ciRuns(ask, REPOSITORY, "main", {});

	assert.equal(read.runs.length, 3);
	assert.equal(read.refused, undefined);

	const byId = standings(read.runs);
	const a = byId.get("specs-1 › a.spec.mjs");
	const b = byId.get("specs-1 › b.spec.mjs");

	assert.deepEqual([
		a.last.verdict,
		a.streak.runs,
		a.flakes,
		a.lastFailed?.verdict
	], ["pass", 1, 1, "flaky"]);
	assert.deepEqual([
		b.last.verdict,
		b.streak.runs,
		b.flakes,
		b.lastFailed?.verdict
	], ["pass", 2, 0, "fail"]);
});

test("a finished job's tests are kept, and not asked of GitHub again", async () => {
	const runs = [
		{
			"id": 1,
			"name": "ci",
			"jobs": [
				{
					"id": 10,
					"name": "test",
					"log": line("✔", "adds")
				}
			]
		}
	];
	const kept = {};

	await ciRuns(shellOf(runs).ask, REPOSITORY, "main", kept);
	assert.deepEqual(kept, {
		"10": [
			{
				"titles": ["adds"],
				"outcome": "pass",
				"ms": 12.5
			}
		]
	});

	const again = shellOf(runs);
	const read = await ciRuns(again.ask, REPOSITORY, "main", kept);

	assert.equal(again.asked.filter((request) => request.job !== undefined).length, 0);
	assert.equal(read.runs[0].attempts[0].jobs[0].tests[0].outcome, "pass");
});

test("a workflow whose latest runs report no tests isn't read further back; one whose last run failed to install is", async () => {
	const quiet = (id, name) => ({
		"id": id,
		"name": name,
		"jobs": [
			{ "id": id * 10, "name": "deploy", "log": "nothing like a test" }
		]
	});
	const { ask, asked } = shellOf([
		quiet(9, "architecture"),
		quiet(8, "cd"),
		{
			"id": 7,
			"name": "architecture",
			"jobs": [
				{
					"id": 70,
					"name": "specs-1",
					"log": line("✔", "a.spec.mjs")
				}
			]
		},
		quiet(6, "cd"),
		quiet(5, "cd"),
		quiet(4, "cd"),
		quiet(3, "cd")
	]);
	const read = await ciRuns(ask, REPOSITORY, "main", {});

	assert.deepEqual(read.runs.map((run) => run.id), ["9", "7", "8", "6", "5"]);
	assert.deepEqual(asked.filter((request) => request.run !== undefined).map((request) => request.run).toSorted(), [5, 6, 7, 8, 9]);
	assert.equal(standings(read.runs).get("specs-1 › a.spec.mjs").last.verdict, "pass");
});

test("signed out: no job or log is asked (each would be refused, against GitHub's 60 an hour), and why is said", async () => {
	const asked = [];
	const ask = async (request) => {
		asked.push(request);

		return {
			"signedIn": false,
			"workflow_runs": [
				{
					"id": 1,
					"name": "ci",
					"status": "completed",
					"head_branch": "main",
					"head_sha": "1".repeat(40),
					"created_at": "2026-11-20T00:00:00Z"
				}
			]
		};
	};

	const read = await ciRuns(ask, REPOSITORY, "main", {});

	assert.equal(asked.length, 1);
	assert.deepEqual(read.runs, []);
	assert.match(read.refused, /signed in with GitHub/u);
});

test("a log refused: no tests, not kept, and why is said; one GitHub hasn't got: no tests, for good", async () => {
	const ask = async (request) => {
		if (request.job === 10) {
			return {
				"signedIn": true,
				"refused": { "status": 403, "message": "GitHub 403: Resource not accessible by integration" }
			};
		}

		if (request.job === 11) {
			return {
				"signedIn": true,
				"refused": { "status": 410, "message": "GitHub 410: Gone" }
			};
		}

		return request.run === undefined
			? {
					"signedIn": true,
					"workflow_runs": [
						{
							"id": 1,
							"name": "ci",
							"status": "completed",
							"head_branch": "main",
							"head_sha": "1".repeat(40),
							"created_at": "2026-11-20T00:00:00Z"
						}
					]
				}
			: {
					"signedIn": true,
					"jobs": [
						{
							"id": 10,
							"name": "test",
							"status": "completed",
							"conclusion": "success"
						},
						{
							"id": 11,
							"name": "old",
							"status": "completed",
							"conclusion": "success"
						}
					]
				};
	};

	const kept = {};
	const read = await ciRuns(ask, REPOSITORY, "main", kept);

	assert.match(read.refused, /Resource not accessible/u);
	assert.deepEqual(kept, { "11": [] });
});

test("a test joined to its file: by the file its first title names, else the one file declaring that title", () => {
	const titles = new Map([
		[
			"packages/editor/test/in-editor/a.spec.mjs",
			titlesOf("test(\"a person does a thing\", async () => {});")
		],
		[
			"packages/editor/test/workbench.mjs",
			titlesOf("test('the theme follows the system\\'s', async () => {});\ndescribe(`a suite`, () => {});")
		],
		[
			"packages/editor/test/other.mjs",
			titlesOf("test(\"shared\", () => {});")
		],
		[
			"packages/editor/test/more.mjs",
			titlesOf("test.skip(\"shared\", () => {});")
		]
	]);

	assert.equal(fileOf({ "id": "specs-1 › a.spec.mjs" }, titles), "packages/editor/test/in-editor/a.spec.mjs");
	assert.equal(fileOf({ "id": "workbench › the theme follows the system's" }, titles), "packages/editor/test/workbench.mjs");
	assert.equal(fileOf({ "id": "workbench › a suite › a test in it" }, titles), "packages/editor/test/workbench.mjs");
	assert.equal(fileOf({ "id": "test › shared" }, titles), undefined);
	assert.equal(fileOf({ "id": "test › nobody's" }, titles), undefined);
});

test("a log of pnpm running each package's tests: each package's lines read apart, as pnpm interleaves them", () => {
	const log = [
		"2026-11-21T13:25:10.0000000Z packages/a test: \u001B[32m✔ adds (1ms)\u001B[39m",
		"2026-11-21T13:25:10.0000001Z packages/b test:   ✔ inner (2ms)",
		"2026-11-21T13:25:10.0000002Z packages/a test: ✖ subtracts (3ms)",
		"2026-11-21T13:25:10.0000003Z packages/b test: ▶ outer (4ms)",
		"2026-11-21T13:25:10.0000004Z ✔ a test of no package's (5ms)"
	].join("\n");

	assert.deepEqual(testsInLog(log).map((test) => [
		test.titles.join(" › "),
		test.outcome
	]).toSorted(), [
		["a test of no package's", "pass"],
		["adds", "pass"],
		["outer › inner", "pass"],
		["subtracts", "fail"]
	]);
});

/* eslint-disable no-template-curly-in-string -- a test file's source, its templates as it has them */
test("a title made as the test runs: a template's or a constant's words, anything between, joins the one file it fits", () => {
	const titles = new Map([
		[
			"packages/tsval/test/test262.test.ts",
			titlesOf("for (const testCase of cases) {\n\ttest(`test262 ${testCase.id}`, async () => {});\n}")
		],
		[
			"packages/tsval/test/evaluator.test.ts",
			titlesOf("const title = `evaluator ${program.id}: ${program.name}`;\ntest(title, () => {});\ntest(`${title} [out of scope: ${why}]`, () => {});")
		],
		[
			"packages/theme/test/budget.mjs",
			// (too few words of its own to say which file it's of: it would fit any title)
			titlesOf("test(`${name}: ${total}`, () => {});\ntest(\"a literal ${not} a template\", () => {});")
		]
	]);

	assert.deepEqual([...titles.get("packages/theme/test/budget.mjs")], ["a literal ${not} a template"]);
	assert.equal(fileOf({ "id": "test › test262 expressions/grouping/S11.1.6_A3_T2.js" }, titles), "packages/tsval/test/test262.test.ts");
	assert.equal(fileOf({ "id": "test › evaluator 12: closures" }, titles), "packages/tsval/test/evaluator.test.ts");
	assert.equal(fileOf({ "id": "test › evaluator 13: eval [out of scope: eval]" }, titles), "packages/tsval/test/evaluator.test.ts");
	assert.equal(fileOf({ "id": "test › a literal ${not} a template" }, titles), "packages/theme/test/budget.mjs");
	assert.equal(fileOf({ "id": "test › stitchesDeclarations: 582" }, titles), undefined);
	// (a title a file declares as it is wins over one another file's pattern fits)
	titles.set("packages/editor/test/other.mjs", titlesOf("test(\"test262 sample is present\", () => {});"));
	assert.equal(fileOf({ "id": "test › test262 sample is present" }, titles), "packages/editor/test/other.mjs");
});
/* eslint-enable no-template-curly-in-string */

test("a line with no time isn't a test's: ESLint's summary, read as a failure, is left out", () => {
	const log = [
		line("✔", "adds"),
		"2026-11-21T13:25:10.0000000Z \u001B[31m✖ 50394 problems (1 error, 50393 warnings)\u001B[39m"
	].join("\n");

	assert.deepEqual(testsInLog(log).map((test) => test.titles.join(" › ")), ["adds"]);
});
