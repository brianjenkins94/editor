/** debug-mcp's own tools, by family — registered in this order, before any page's (mcp.ts). */
import architecture from "./architecture.ts";
import logs from "./logs.ts";
import metrics from "./metrics.ts";
import payloads from "./payloads.ts";
import spans from "./spans.ts";
import tabs from "./tabs.ts";
import tree from "./tree.ts";

export const FAMILIES = [logs, spans, tree, architecture, metrics, payloads, tabs];
