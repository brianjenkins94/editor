/**
 * ci_status's reading (workbench/ci-status.ts): a commit's runs, with the jobs of each that didn't pass; a job's log as
 * an agent reads it; and GitHub's refusals said with why. The shell's answers are made up here.
 *
 *   node --import tsx --test test/ci-status.test.mjs
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { ciStatus, logOf } = await import("../workbench/ci-status.ts");

const REPOSITORY = "octo/hello";
const COMMIT = "a".repeat(40);

test("a commit's runs: each workflow's conclusion, and the jobs of one that failed, its failed steps", async () => {
	const asked = [];
	const ask = async (request) => {
		asked.push(request);

		if (request.run === 2) {
			return { "signedIn": true, "jobs": [{ "id": 20, "name": "lint", "status": "completed", "conclusion": "failure", "steps": [{ "name": "install", "conclusion": "success" }, { "name": "eslint", "conclusion": "failure" }], "html_url": "https://github.com/octo/hello/actions/runs/2/job/20" }] };
		}

		return { "signedIn": true, "workflow_runs": [{ "id": 1, "name": "cd", "status": "completed", "conclusion": "success", "head_branch": "main" }, { "id": 2, "name": "ci", "status": "completed", "conclusion": "failure", "head_branch": "main" }] };
	};
	const answer = await ciStatus(ask, { "repository": REPOSITORY, "commit": COMMIT });

	assert.deepEqual(answer.runs.map(({ id, workflow, conclusion }) => [id, workflow, conclusion]), [[1, "cd", "success"], [2, "ci", "failure"]]);
	assert.equal(answer.runs[0].jobs, undefined, "a run that passed: its jobs not asked");
	assert.deepEqual(answer.runs[1].jobs.map(({ id, name, failedSteps }) => [id, name, failedSteps]), [[20, "lint", ["eslint"]]]);
	assert.deepEqual(asked, [{ "repository": REPOSITORY, "commit": COMMIT, "limit": 20 }, { "repository": REPOSITORY, "run": 2 }]);
});

test("no runs: said, so an empty list isn't read as green", async () => {
	const answer = await ciStatus(async () => ({ "signedIn": true, "workflow_runs": [] }), { "repository": REPOSITORY, "commit": COMMIT });

	assert.deepEqual(answer.runs, []);
	assert.match(answer.none, /isn't pushed, or CI hasn't started/u);
});

test("a job's log: its last lines without timestamps or colors, its errors, and the tests it failed", () => {
	const log = [
		"2026-10-30T14:41:50.0000000Z ✔ boot: every realm reports (12.5ms)",
		"2026-10-30T14:41:51.0000000Z \u001B[31m✖ purity: a pure one flagged (20194.04ms)\u001B[39m",
		"2026-10-30T14:41:51.1000000Z ℹ tests 2",
		"2026-10-30T14:41:52.0000000Z ##[error]Process completed with exit code 1.",
		""
	].join("\n");
	const read = logOf(log, 2);

	assert.deepEqual(read.lines, { "total": 4, "shown": 2 });
	assert.equal(read.log, "ℹ tests 2\n##[error]Process completed with exit code 1.");
	assert.deepEqual(read.errors, ["Process completed with exit code 1."]);
	assert.deepEqual(read.failedTests, ["purity: a pure one flagged"]);
});

test("a refusal says why: signed out, public runs only; signed in, the App's Actions permission", async () => {
	const refused = (signedIn) => async () => ({ "signedIn": signedIn, "refused": { "status": 403, "message": "GitHub 403: Resource not accessible by integration" } });

	assert.match((await ciStatus(refused(false), { "repository": REPOSITORY, "job": 20 })).error, /signed out .* sign in with GitHub/u);
	assert.match((await ciStatus(refused(true), { "repository": REPOSITORY, "commit": COMMIT })).error, /Actions \(read\)/u);
	assert.match((await ciStatus(refused(true), { "repository": REPOSITORY, "run": 2 })).error, /Resource not accessible/u);
});
