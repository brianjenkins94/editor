/// <reference types="vite/client" />
/**
 * The editor tab's MCP tools, found rather than listed: every family's `tools.ts` (host.ts), served from this tab as
 * page tools (page-tools.ts) — which debug-mcp registers while it's connected, beside every page's page_eval /
 * page_query. Adding a family is adding a folder. Each requests from this tab's root hub, so it reaches only this tab's
 * tree; a call the agent gives up on is cancelled down the tree.
 */
import type { PageTool } from "@brianjenkins94/observability";
import type { Hub } from "@brianjenkins94/hub";
import type { ToolFamily } from "./host";
import { createToolHost, toPageTools } from "./page-tools";

const families = import.meta.glob<ToolFamily>("./*/tools.ts", { "eager": true, "import": "default" });

/** Every family's tools, as this tab's page tools. `commands`: the terminal's own, named in the shell tool. */
export function editorTools(hub: Hub, options: { "commands"?: string } = {}): PageTool[] {
	const host = createToolHost(hub, options);

	return toPageTools(Object.keys(families).sort().flatMap((path) => families[path]!(host)));
}
