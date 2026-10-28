/** The terminals' output (`terminal.state`, terminal/index.ts), as data. Running a command line is people's: an agent acts
 * through the other families' tools (host.ts). */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const terminal: ToolFamily = ({ request }) => [
	{
		"timeoutMs": 5000,
		"tool": defineTool({
			"name": "terminal_output",
			"config": {
				"description": "The terminals, as data: each one's number, whether it's open, the command it runs (a task's terminal), its latest output (ANSI escapes stripped) and what it's running (its runs: id, title, state). It reads what they printed; it doesn't run anything.",
				"inputSchema": {
					"terminal": z.number().optional().describe("Only this terminal (its number, from 1)."),
					"lines": z.number().optional().describe("The latest this many lines of each one's output (default 50).")
				}
			},
			"handler": async ({ "terminal": number, lines }, { signal }) => ok(request("terminal.state", { "terminal": number, "lines": lines }, signal))
		})
	}
];

export default terminal;
