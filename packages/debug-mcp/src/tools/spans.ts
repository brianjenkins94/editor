/** Timed spans rebuilt from the stream, including the ones still open (the store's querySpans). */
import type { QuerySpansInput } from "../store.ts";
import type { ToolsContext } from "./context.ts";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

export default ({ store, FROM, named, scoped, withTab }: ToolsContext) => [defineTool({
	"name": "spans_query",
	"config": {
		"title": "Query spans",
		"description": "Query timed spans reconstructed from the stream — each with source, name, duration, and trace ids. Includes spans that are still OPEN (e.g. a debug step paused at a breakpoint) when onlyOpen is set.",
		"inputSchema": {
			"source": z.string().optional().describe("Emitting context."),
			"name": z.string().optional().describe("Span name, e.g. 'step', 'cdn', 'editor-window'."),
			"minDurationMs": z.number().optional().describe("Only spans that took at least this long."),
			"onlyOpen": z.boolean().optional().describe("Only spans with no close yet (in progress)."),
			"sinceMs": z.number().optional().describe("Only spans that started in the last N milliseconds."),
			"limit": z.number().optional().describe("Max rows, default 200."),
			"from": FROM
		}
	},
	"handler": async (args) => {
		const { from, ...input } = args as QuerySpansInput & { "from"?: string };

		return withTab(from, async (link) => ok(await named(store.querySpans({ ...input, ...link === undefined ? {} : { "link": link }, ...scoped(from) }))));
	}
})];
