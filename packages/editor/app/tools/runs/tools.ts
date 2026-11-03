/** What's running and what ran (`runs.list` / `runs.stop`, runs.ts), and test runs: which a change reaches and their
 *  results as data (`tests.affected` / `tests.run`, test-runs.ts). */
import type { PageToolAsk } from "@brianjenkins94/observability";
import type { PageToolContext, ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";
import { Ask } from "../host";

const runs: ToolFamily = ({ request }) => [
	{
		"tool": defineTool({
			"name": "runs_list",
			"config": {
				"description": "What's running in the editor, and what ran lately: every terminal's runs — a SERVICE runs until stopped (a dev server: `vite`, `npm run dev`, with its preview port), a TASK runs to completion (a `node` script) — each with its id, title, cwd, the terminal it came from, state (running / exited / failed / stopped), start and end times and exit code.",
				"inputSchema": {}
			},
			"handler": async (_args, { signal }) => ok(request("runs.list", undefined, signal))
		})
	},
	{
		"tool": defineTool({
			"name": "runs_stop",
			"config": {
				"description": "Stop a running run (its id from runs_list). Returns { stopped }.",
				"inputSchema": { "id": z.string().describe("The run's id.") }
			},
			"handler": async ({ id }, { signal }) => ok({ "stopped": await request("runs.stop", { "id": id }, signal) })
		})
	},
	{
		"timeoutMs": 120000,
		"tool": defineTool({
			"name": "runs_affected",
			"config": {
				"description": "The tests a change reaches: those whose last run here ran code in the working tree's changed files (or the files given), by the traces the editor keeps of each test. Each has its last outcome, and stale when it ran code the change has altered since (it hasn't run on this code: run it). untraced lists the test files with no trace at all: what they reach isn't known until they run once, so the list without them isn't complete. Returns { tests: [{ id, file, outcome, at, stale, reaches }], changed, untraced }.",
				"inputSchema": { "paths": z.array(z.string()).optional().describe("These files instead of the changed ones (relative to the workspace).") }
			},
			"handler": async ({ paths }, { signal }) => ok(request("tests.affected", { "paths": paths }, signal))
		})
	},
	{
		// (a run answers within 50 s — done, or where it is — so a call never waits out an agent's tool limit in silence)
		"timeoutMs": 120000,
		"tool": defineTool({
			"name": "runs_tests",
			"config": {
				"description": "Run test files (node:test, in the editor's debugger, one file at a time, as node --test does) and get each test's result as data: its outcome, what it threw, what a failed assertion compared (actual, expected, operator), its time, and how it came out before this run (before), so a newly failing test reads apart from one failing all along. Without files, the stale ones runs_affected lists run. A file that failed without a failed test (it didn't load, say) has its output's end; a gated call the policy leaves undecided (fs, fetch, …) is asked of the person first — BERNARD's redline only as a break-glass, JUDICIAL if it's set — and the call re-invoked with the approval allows it, this once. Answers within a minute: a run not done by then answers { run, running (what it's doing, for how long), files so far } and goes on — call again with that run to wait for more (a dropped call leaves the run going; runs_stop stops a file's run). Returns { run, files: [{ file, exitCode, ms, tests: [{ id, outcome, error?, assertion?, ms?, before? }], output?, stalled? }], counts: { files, pass, fail, skip } }.",
				"inputSchema": {
					"files": z.array(z.string()).optional().describe("The test files to run (relative to the workspace); default, the affected tests' that are stale."),
					"run": z.string().optional().describe("A run this tool answered `running` for: wait on it again instead of starting one.")
				}
			},
			"handler": async ({ files, run }, context) => {
				const ran = await request("tests.run", { "files": files, "run": run, "approved": (context as PageToolContext).approved }, context.signal) as { "ask"?: PageToolAsk["ask"] };

				// (a gated call the policy leaves undecided: asked of the person — BERNARD, JUDICIAL, then them — before it runs)
				if (ran.ask !== undefined) {
					throw new Ask(ran.ask);
				}

				return ok(ran);
			}
		})
	}
];

export default runs;
