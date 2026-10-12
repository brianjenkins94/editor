/** The collected log and span records: queried (the store's queryLogs), or waited on — block until a matching record
 *  arrives, so an agent waits on a real event instead of polling. */
import type { QueryLogsInput, WaitInput } from "../store.ts";
import type { ToolsContext } from "./context.ts";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";
import { KIND, LEVEL } from "./context.ts";

export default ({ store, FROM, named, scoped, withTab }: ToolsContext) => [defineTool({
	"name": "logs_query",
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
			"from": FROM
		}
	},
	"handler": async (args) => {
		const { from, ...input } = args as QueryLogsInput & { "from"?: string };

		return withTab(from, async (link) => ok(await named(store.queryLogs({ ...input, ...link === undefined ? {} : { "link": link }, ...scoped(from) }))));
	}
}), defineTool({
	"name": "logs_wait",
	"config": {
		"title": "Wait for a record",
		"description": "Block until the FIRST record matching the filter arrives (or timeout), so you can synchronize on a real event — e.g. wait for a 'rendered' message from debug-worker, or any error — instead of polling or sleeping. Returns the matching record, or {timedOut:true}.",
		"inputSchema": {
			"source": z.string().optional().describe("Emitting context to match."),
			"minLevel": LEVEL.optional().describe("Match only at or above this level (e.g. 'error')."),
			"textIncludes": z.string().optional().describe("Substring the message must contain."),
			"kind": KIND.optional().describe("Match only this record kind."),
			"spanName": z.string().optional().describe("Match a span by name."),
			"timeoutMs": z.number().optional().describe("Give up after this long (default 30000)."),
			"from": FROM
		}
	},
	"handler": async (args) => {
		const { from, ...input } = args as WaitInput & { "from"?: string };

		return withTab(from, async (link) => {
			const record = await store.waitFor({ ...input, ...link === undefined ? {} : { "link": link }, "timeoutMs": input.timeoutMs ?? 30000 });

			return ok(record === null ? { "timedOut": true } : (await named([record]))[0]);
		});
	}
})];
