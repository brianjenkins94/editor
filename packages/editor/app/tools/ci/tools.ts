/** How a commit did in CI: its GitHub Actions runs, a run's jobs, a job's log (ci-status.ts). */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const ci: ToolFamily = ({ request }) => [
	{
		"timeoutMs": 120000,
		"tool": defineTool({
			"name": "ci_status",
			"config": {
				"description": "How a commit did in CI (GitHub Actions on the workspace's github.com origin), as data. With no arguments, HEAD's runs: each workflow's status and conclusion, and for each run that didn't pass, its jobs with their failed steps. With `run`, that run's jobs. With `job`, that job's log: `lines` of it (default 200, timestamps and colors removed) ending at its first ##[error] (the failed step's end), else its last, its ##[error] lines, and the tests its node:test report failed. A short sha is expanded from the workspace's history. Signed out, only a public repository's runs, and no logs; a refusal says why. Returns { repository, commit, runs: [{ id, workflow, status, conclusion, jobs?: [{ id, name, conclusion, failedSteps? }] }] } or, for a job, { lines: { total, shown }, failedTests, errors, log }.",
				"inputSchema": {
					"commit": z.string().optional().describe("A commit's sha (whole or short); HEAD by default."),
					"run": z.number().int().optional().describe("A run's id (from `runs`): its jobs."),
					"job": z.number().int().optional().describe("A job's id (from a run's `jobs`): its log."),
					"lines": z.number().int().positive().optional().describe("How many of the log's lines (default 200, at most 2000), ending at its first error.")
				}
			},
			"handler": async ({ commit, run, job, lines }, { signal }) => ok(request("ci.status", { "commit": commit, "run": run, "job": job, "lines": lines }, signal))
		})
	}
];

export default ci;
