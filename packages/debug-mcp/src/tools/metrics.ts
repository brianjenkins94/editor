/** One tab's metrics plane: its gauges and the rates and percentiles derived from its spans. */
import type { ToolsContext } from "./context.ts";
import { defineTool, fail, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";
import { resolveTab } from "../forward.ts";

export default ({ debugMcp }: ToolsContext) => [defineTool({
	"name": "metrics_query",
	"config": {
		"title": "Query metrics",
		"description": "The metrics plane of one tab: every context's gauges, sampled once a second — memory by realm (MB; the workbench's `memory.*`), the workspace file system's fill, long-frame share (%), hub messages/s, origin storage, and span metrics derived from every context's timed spans (`root:spans.SOURCE/NAME.rate`, `.errors`, `.p50`, `.p95`, `.open` — e.g. the service worker's CDN fetches as `sw/cdn`). Each series over the window: latest, min, max, mean; `points` adds the readings themselves.",
		"inputSchema": {
			"match": z.string().optional().describe("Only series whose `source:gauge` name contains this (case-insensitive), e.g. 'memory', 'spans', 'sw/cdn', 'errors'."),
			"source": z.string().optional().describe("Only this context's gauges, e.g. 'workbench', 'shell', 'root'."),
			"sinceMs": z.number().optional().describe("The window: the last N milliseconds (default 60000; up to five minutes are kept)."),
			"points": z.number().int().nonnegative().optional().describe("Also return each series' readings, thinned to at most this many ([msAgo, value], oldest first)."),
			"tab": z.string().optional().describe("The tab (from tabs_list). Omit for the editor tab.")
		}
	},
	"handler": async ({ match, source, sinceMs, points, tab }: { "match"?: string; "source"?: string; "sinceMs"?: number; "points"?: number; "tab"?: string }) => {
		let resolved: string;

		try {
			resolved = await resolveTab(debugMcp, tab);
		} catch (error) {
			return fail(error instanceof Error ? error.message : String(error));
		}

		const metrics = debugMcp.metricsOf(resolved);

		if (metrics === undefined) {
			return fail(`tab ${resolved} hasn't reported any metrics yet (they're sampled once a second; memory takes ~20 s to first appear)`);
		}

		return ok(metrics.summarize({ "match": match, "source": source, "sinceMs": sinceMs, "points": points }));
	}
})];
