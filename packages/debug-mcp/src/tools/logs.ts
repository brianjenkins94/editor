/** The collected log and span records, queried (the store's queryLogs). */
import type { QueryLogsInput } from "../store.ts";
import type { ToolsContext } from "./context.ts";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";
import { KIND, LEVEL } from "./context.ts";

export default ({ store, TAB_FILTER, named, scoped, withTab }: ToolsContext) => [defineTool({
	"name": "query_logs",
	"config": {
		"title": "Query logs",
		"description": "Query the collected log/span record stream federated from the editor's hub tree. Point events and span boundaries, filtered by source (e.g. 'debug-worker', 'sw', 'workbench'), minimum level, message substring, and time window.",
		"inputSchema": {
			"source": z.string().optional().describe("Emitting context, e.g. 'debug-worker', 'sw', 'workbench', 'pod', 'root'."),
			"minLevel": LEVEL.optional().describe("Only records at or above this level."),
			"textIncludes": z.string().optional().describe("Substring the message must contain."),
			"sinceMs": z.number().optional().describe("Only records from the last N milliseconds."),
			"since": z.number().optional().describe("Absolute lower bound (unix ms); overrides sinceMs."),
			"until": z.number().optional().describe("Absolute upper bound (unix ms)."),
			"kind": KIND.optional().describe("Restrict to one record kind; default returns all."),
			"limit": z.number().optional().describe("Max rows (most recent), default 200."),
			"tab": TAB_FILTER
		}
	},
	"handler": async (args) => {
		const { tab, ...input } = args as QueryLogsInput & { "tab"?: string };

		return withTab(tab, async (link) => ok(await named(store.queryLogs({ ...input, ...link === undefined ? {} : { "link": link }, ...scoped(tab) }))));
	}
})];
