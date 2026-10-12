/** Block until a matching record arrives, so an agent waits on a real event instead of polling. */
import type { WaitInput } from "../store.ts";
import type { ToolsContext } from "./context.ts";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";
import { KIND, LEVEL } from "./context.ts";

export default ({ store, TAB_FILTER, named, withTab }: ToolsContext) => [defineTool({
	"name": "wait_for",
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
			"tab": TAB_FILTER
		}
	},
	"handler": async (args) => {
		const { tab, ...input } = args as WaitInput & { "tab"?: string };

		return withTab(tab, async (link) => {
			const record = await store.waitFor({ ...input, ...link === undefined ? {} : { "link": link }, "timeoutMs": input.timeoutMs ?? 30000 });

			return ok(record === null ? { "timedOut": true } : (await named([record]))[0]);
		});
	}
})];
