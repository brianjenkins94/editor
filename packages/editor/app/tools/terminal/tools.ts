/** The workspace's shell (`shell.run`, workspace-tools.ts) and the terminals' output (`terminal.state`, terminal/index.ts). */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const terminal: ToolFamily = ({ request, commands }) => [{
	"timeoutMs": 600000,
	"tool": defineTool({
		"name": "terminal_run",
		"config": {
			"description": "Run a command line in the workspace's shell — just-bash on the workspace's files, as the terminal runs it: ls, cat, grep, rg, sed, awk, find, jq, diff, mkdir, mv, rm, echo > file" + (commands === "" ? "" : "; and the editor's own: " + commands) + ". Each call is its own shell: cd and export don't carry over (pass cwd). Returns { exitCode, output (stdout and stderr, as printed), timedOut }.",
			"inputSchema": {
				"command": z.string().describe("The command line."),
				"cwd": z.string().optional().describe("Where it runs, relative to the workspace or absolute under it (default /workspace)."),
				"timeoutMs": z.number().optional().describe("Stop it after this long (default 120000).")
			}
		},
		"handler": async ({ command, cwd, timeoutMs }, { signal }) => ok(request("shell.run", { "command": command, "cwd": cwd, "timeoutMs": timeoutMs }, signal))
	})
}, {
	"timeoutMs": 5000,
	"tool": defineTool({
		"name": "terminal_output",
		"config": {
			"description": "The terminals, as data: each one's number, whether it's open, the command it runs (a task's terminal), its latest output (ANSI escapes stripped) and what it's running (its runs: id, title, state). terminal_run runs a command line in a shell of its own; this reads what the terminals printed.",
			"inputSchema": {
				"terminal": z.number().optional().describe("Only this terminal (its number, from 1)."),
				"lines": z.number().optional().describe("The latest this many lines of each one's output (default 50).")
			}
		},
		"handler": async ({ terminal: number, lines }, { signal }) => ok(request("terminal.state", { "terminal": number, "lines": lines }, signal))
	})
}];

export default terminal;
