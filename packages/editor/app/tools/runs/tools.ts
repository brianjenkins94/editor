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
				"description": "Stop a running run (its id from runs_list). A test file's run (runs_tests') stops the whole run of tests it's in, the files after it not run, as Ctrl+C stops node --test. Returns { stopped }.",
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
				"description": "The tests a change reaches: those whose last run here ran the lines changed since the last commit (all of a file git hasn't yet, or of one given that hasn't changed), or that are in a changed test file, by the traces the editor keeps of each test. Each has its last outcome, and stale when it ran code the change has altered since (it hasn't run on this code: run it). why says, for each changed file, why it selected what it did: test (itself), lines run, lines not run and not run (no test here checks that change: none is selected for it, which isn't the same as safe), config (what every test runs under: package.json, a tsconfig, the policy) or not code. untraced lists the unit tests and specs with no trace at all (the first 50; untracedLeftOut, how many more): what they reach isn't known until they run once here, so the list without them isn't complete; outside counts the browser suites, run from outside the editor, whose reach isn't known here at all. A test folder's helpers and fixtures aren't counted. Returns { tests: [{ id, file, outcome, at, stale, reaches }], changed, why: [{ path, why, tests }], untraced, untracedLeftOut?, outside }.",
				"inputSchema": { "paths": z.array(z.string()).optional().describe("These files instead of the changed ones (relative to the workspace): their lines changed since the last commit, or all of one that hasn't changed.") }
			},
			"handler": async ({ paths }, { signal }) => ok(request("tests.affected", { "paths": paths }, signal))
		})
	},
	{
		"timeoutMs": 120000,
		"tool": defineTool({
			"name": "runs_tests",
			"config": {
				"description": "Run test files (node:test, in the editor's debugger, one file at a time, as node --test does) and get each test's result as data: its outcome, what it threw, what a failed assertion compared (actual, expected, operator), its time, and how it came out before this run (before), so a newly failing test reads apart from one failing all along. Without files, the stale ones runs_affected lists run. A file that failed without a failed test (it didn't load, say) has its output's end; a gated call the policy leaves undecided (fs, fetch, …) is asked of the person first — BERNARD's redline only as a break-glass, JUDICIAL if it's set — and the call re-invoked with the approval allows it, this once. Answers within a minute: a run not done by then answers { run, running (what it's doing, for how long), files so far } and goes on — call again with that run to wait for more (a dropped call leaves the run going; runs_stop on its file's run, from runs_list, stops it: then stopped says so). Returns { run, files: [{ file, exitCode, ms, tests: [{ id, outcome, error?, assertion?, ms?, before? }], output?, stalled? }], counts: { files, pass, fail, skip }, stopped? }.",
				"inputSchema": {
					"files": z.array(z.string()).optional().describe("The test files to run (relative to the workspace); default, the affected tests' that are stale."),
					"run": z.string().optional().describe("A run this tool answered `running` for: wait on it again instead of starting one."),
					"imports": z.array(z.string()).optional().describe("Modules to load before each file, as node's --import does (`node --import <module> --test`, in the terminal): a package's test loader, from its npm test script — relative to the workspace's root.")
				}
			},
			"handler": async ({ files, run, imports }, context) => {
				const ran = await request("tests.run", { "files": files, "run": run, ...imports === undefined ? {} : { "imports": imports }, "approved": (context as PageToolContext).approved }, context.signal) as { "ask"?: PageToolAsk["ask"] };

				if (ran.ask !== undefined) {
					throw new Ask(ran.ask);
				}

				return ok(ran);
			}
		})
	},
	{
		"timeoutMs": 120000,
		"tool": defineTool({
			"name": "runs_notice",
			"config": {
				"description": "What a test file's tests notice broken (Tests: What This File's Tests Notice Broken): its tests run once, then once with each statement they ran, outside test files, skipped in turn — their own feature's code first — and a test that fails with one skipped noticed it. Results are kept (.silo/local/notice/) until the code changes, so each call tries more, for about 90 s: `left` says how many statements are still to try. A test that noticed none of those tried is in `none` and in Problems, a drop candidate for a person to decide, never dropped. Only a passing file is checked (`failing` otherwise). Returns { file, statements, tried, left, tests: [{ id, tried, noticed, missed (statements as path:line:column) }], none }.",
				"inputSchema": { "file": z.string().describe("The test file (relative to the workspace).") }
			},
			"handler": async ({ file }, { signal }) => ok(request("tests.notice", { "file": file }, signal))
		})
	}
];

export default runs;
