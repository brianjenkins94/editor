/** The hub tree's health: its links, every context's last message, the spans open now. */
import type { ToolsContext } from "./context.ts";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";

export default ({ debugMcp, store, TAB_FILTER, named, withTab }: ToolsContext) => [defineTool({
	"name": "get_tree_state",
	"config": {
		"title": "Get tree state",
		"description": "Health snapshot of the hub tree: how many pages are linked, every context (source) seen — per tab — with its last message and how long ago, and all currently-open spans. Pass `tab` for one tab's. The one-call answer to 'what is the editor doing right now?'.",
		"inputSchema": {
			"tab": TAB_FILTER
		}
	},
	"handler": async ({ tab }: { "tab"?: string }) => withTab(tab, async (link) => {
		const state = store.treeState(debugMcp.linkCount(), link);

		return ok({ ...state, "sources": await named(state.sources), "openSpans": await named(state.openSpans) });
	})
})];
