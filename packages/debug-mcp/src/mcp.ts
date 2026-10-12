/**
 * The MCP face of the debug-mcp — the tools an agent uses to see what the live editor did WITHOUT a screenshot:
 * query_logs (point events), query_spans (timed operations, incl. still-open ones), query_metrics (the gauges sampled
 * once a second, and rates/errors/latencies derived from the spans), get_tree_state (which contexts are alive + what's
 * running now), and wait_for (block until a matching record arrives, so the agent synchronizes on a real event instead
 * of polling).
 *
 * Tools are authored with @brianjenkins94/util/mcp's model (`defineTool` + `ok`), so they read and behave like
 * every other tool in that ecosystem (same result shape, same MRTR confirm context). We mount them onto an
 * McpServer we own rather than going through `serveMcp`, because this process ALSO runs the WebSocket collector
 * — serveMcp owns the process (its own stdio / Vite dev bridge), which leaves no room for the WS server; here
 * the two share one process and one store. Its own tools are a file per family in tools/ (index.ts lists them), all
 * read-only but capture_payloads; the page tools (page-tools.ts) act on the live editor, which only links to debug-mcp
 * in dev (localhost, or `?debug`).
 */
import type { DebugMcp } from "./server.ts";
import { registerTool } from "@brianjenkins94/util/mcp/tool";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { syncPageTools } from "./page-tools.ts";
import { createToolsContext } from "./tools/context.ts";
import { FAMILIES } from "./tools/index.ts";

/** Build the MCP server exposing the debug-mcp's store. Connect it to a transport (stdio) to serve. */
export function createMcpServer(debugMcp: DebugMcp): McpServer {
	const server = new McpServer({ "name": "debug-mcp", "version": "0.0.0" });
	const context = createToolsContext(debugMcp);

	for (const family of FAMILIES) {
		for (const tool of family(context)) {
			registerTool(server, tool);
		}
	}

	// Everything a tab exposes — page_eval, page_query, the editor's debugger, a game's own — is a page tool, registered
	// while a tab serving it is connected (each call to ONE tab: the one named, or the only one connected — forward.ts).
	// Last, so a page can't take over any of the tools above.
	syncPageTools(server, debugMcp);

	return server;
}
