/** The hub tree's health: its links, every context's last message, the spans open now. */
import type { ToolsContext } from "./context.ts";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";

export default ({ debugMcp, store, FROM, named, withTab }: ToolsContext) => [defineTool({
	"name": "tree_state",
	"config": {
		"title": "Tree state",
		"description": "Health snapshot of the hub tree: how many pages are linked, every context (source) seen — per tab — with its last message and how long ago, and all currently-open spans. Pass `from` for one tab's. The one-call answer to 'what is the editor doing right now?'.",
		"inputSchema": {
			"from": FROM
		}
	},
	"handler": async ({ from }: { "from"?: string }) => withTab(from, async (link) => {
		const state = store.treeState(debugMcp.linkCount(), link);

		return ok({ ...state, "sources": await named(state.sources), "openSpans": await named(state.openSpans) });
	})
})];
