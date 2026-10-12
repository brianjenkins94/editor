/** The tabs connected now. */
import type { ToolsContext } from "./context.ts";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";

export default ({ debugMcp }: ToolsContext) => [defineTool({
	"name": "list_tabs",
	"config": {
		"title": "List editor tabs",
		"description": "The editor tabs connected right now: [{ tab, url, title, visible, focused }]. The page and debugger tools act on one tab — pass its `tab` when several are connected.",
		"inputSchema": {}
	},
	"handler": async () => ok(await debugMcp.tabs())
})];
