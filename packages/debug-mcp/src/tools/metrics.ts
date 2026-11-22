/** One tab's metrics plane: its gauges and the rates and percentiles derived from its spans. */
import type { ToolsContext } from "./context.ts";
import { defineTool, fail, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";
import type { MetricsHistory } from "../../../observability/src/metrics.ts";
import { resolveTab } from "../forward.ts";

/** How long a tab reports before its memory's absence says something (the page's gauge takes ~20 s to first answer). */
const MEMORY_FIRST_MS = 30_000;

/** When memory was asked about (or everything was) and there's no reading of it, a row saying why: the page's gauge
 *  doesn't answer in this browser, and debug-mcp has no DevTools endpoint to read it through (cdp-memory.ts). */
function memorySaid(metrics: MetricsHistory, via: string | undefined, match: string | undefined, source: string | undefined): { "series": string; "said": string }[] {
	const asked = (match === undefined || /memory|heap|backing|cdp/iu.test(match)) && (source === undefined || source === "cdp");
	const all = metrics.read();
	const first = Math.min(...Object.values(all).flatMap((samples) => samples.map((sample) => sample.t)));
	const measured = Object.entries(all).some(([from, samples]) => from === "cdp" || samples.some((sample) => Object.keys(sample.values).some((name) => name.startsWith("memory"))));

	if (!asked || measured || Date.now() - first < MEMORY_FIRST_MS) {
		return [];
	}

	return [{ "series": "memory", "said": via === undefined
		? "no readings: this browser doesn't answer the page's measureUserAgentSpecificMemory (Brave never resolves it; the desktop app's pane hasn't it), and debug-mcp has no DevTools endpoint to read each realm's heap through — start the browser with --remote-debugging-port=9222, or set DEBUG_MCP_CDP to its address, and restart debug-mcp"
		: `no readings yet through ${via}: is this tab's page among the browser's targets?` }];
}

export default ({ debugMcp }: ToolsContext) => [defineTool({
	"name": "metrics_query",
	"config": {
		"title": "Query metrics",
		"description": "The metrics plane of one tab: every context's gauges, sampled once a second — memory by realm (MB; the workbench's `memory.*`, where the browser answers it; and, where debug-mcp reaches the browser's DevTools endpoint — DEBUG_MCP_CDP, else port 9222 — every 5 s each realm's heap and ArrayBuffer backing stores, `cdp:heap.<realm>` and `cdp:backing.<realm>`; with neither, a row says so), the workspace file system's fill, long-frame share (%), hub messages/s, origin storage, and span metrics derived from every context's timed spans (`root:spans.SOURCE/NAME.rate`, `.errors`, `.p50`, `.p95`, `.open` — e.g. the service worker's CDN fetches as `sw/cdn`). Each series over the window: latest, min, max, mean; `points` adds the readings themselves.",
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

		const series = metrics.summarize({ "match": match, "source": source, "sinceMs": sinceMs, "points": points });

		return ok([...series, ...memorySaid(metrics, debugMcp.memoryVia(), match, source)]);
	}
})];
