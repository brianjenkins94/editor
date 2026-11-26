/** The agent's own tool use, and what it says about the tools: what Features and Tests shows of it, in the editor. */
import type { ToolsContext } from "./context.ts";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { withFindings } from "../agent-audit.ts";

export default ({ debugMcp }: ToolsContext) => [defineTool({
	"name": "agent_usage",
	"config": {
		"title": "Agent tool use",
		"description": "How agents have used their tools since `since` (kept across restarts in .silo/local/agent-tools.json): each tool's { tool, via: \"editor\" (debug-mcp's and the editor's) | \"around\" (Claude Code's own, from its hooks), calls, failures, ms, bytes, largest, linked (around: calls while an editor was linked), programs (Bash, while linked: each command's own program, how often), first, last }, most used first; and `findings`, what that says about the tools: bypass (around the editor while it was linked, though an editor tool does it: `instead`), candidate (a program run often that no editor tool does: one to write, its UI first), workaround (page_eval standing in), friction (failing often), oversize (an answer too big to read whole). The editor shows the same in Features and Tests.",
		"inputSchema": {}
	},
	"handler": async () => ok(withFindings(debugMcp.agent.usage()))
})];
