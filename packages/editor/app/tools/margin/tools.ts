/** What a file's Margin shows beside its code, as data rather than read off its page (the margin extension's `margin.state`). */
import type { ToolFamily } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const margin: ToolFamily = ({ request }) => [{
	"timeoutMs": 5000,
	"tool": defineTool({
		"name": "margin_state",
		"config": {
			"description": "What a file's Margin shows beside its code, as data: how its run went, each row on its line now (1-based) with its label and its value or a column per turn of a loop, a call it didn't make (unmade), how many values were left out, and the question a stopped run is asking (answer it with debug_decide).",
			"inputSchema": { "file": z.string().optional().describe("The file, absolute or relative to the workspace. Default: the file open in the editor.") }
		},
		"handler": async ({ file }, { signal }) => ok(request("margin.state", { "file": file }, signal))
	})
}];

export default margin;
