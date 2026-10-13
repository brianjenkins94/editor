/** What a file's Margin tab shows, as data — rather than read off its DOM (`margin.state`, live-values.ts). */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const margin: ToolFamily = ({ request }) => [{
	"timeoutMs": 5000,
	"tool": defineTool({
		"name": "margin_state",
		"config": {
			"description": "What a file's Margin tab shows beside its code (LIVE-VALUES.md), as data: the last run's values (each row's 1-based line, label and cells — a column per loop turn), what the bounds dropped, a capability stop's question, how the run ended, the marks in its gutter column (coverage, the run's end — placed rules are rules_list's), its cards and its run log. The file must be open in the editor.",
			"inputSchema": { "file": z.string().optional().describe("The file, absolute or relative to the workspace. Default: the file open in the editor.") }
		},
		"handler": async ({ file }, { signal }) => ok(request("margin.state", { "file": file }, signal))
	})
}];

export default margin;
