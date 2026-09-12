/**
 * The MCP face of the dev-hub — the four tools an agent uses to see what the live editor did WITHOUT a
 * screenshot: query_logs (point events), query_spans (timed operations, incl. still-open ones), get_tree_state
 * (which contexts are alive + what's running now), and wait_for (block until a matching record arrives, so the
 * agent synchronizes on a real event instead of polling).
 *
 * Tools are authored with @brianjenkins94/util/mcp's model (`defineTool` + `ok`), so they read and behave like
 * every other tool in that ecosystem (same result shape, same MRTR confirm context). We mount them onto an
 * McpServer we own rather than going through `serveMcp`, because this process ALSO runs the WebSocket collector
 * — serveMcp owns the process (its own stdio / Vite dev bridge), which leaves no room for the WS server; here
 * the two share one process and one store. These tools are read-only, so no broker/run-ledger wiring is needed.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { defineTool, ok, registerTool } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

import type { DevHub } from "./server.ts";
import type { QueryLogsInput, QuerySpansInput, WaitInput } from "./store.ts";

const LEVEL = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
const KIND = z.enum(["log", "span-open", "span-close"]);

/** Build the MCP server exposing the dev-hub's store. Connect it to a transport (stdio) to serve. */
export function createMcpServer(devHub: DevHub): McpServer {
	const server = new McpServer({ "name": "dev-hub", "version": "0.0.0" });
	const store = devHub.store;

	registerTool(server, defineTool({
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
				"limit": z.number().optional().describe("Max rows (most recent), default 200.")
			}
		},
		"handler": (args) => ok(store.queryLogs(args as QueryLogsInput))
	}));

	registerTool(server, defineTool({
		"name": "query_spans",
		"config": {
			"title": "Query spans",
			"description": "Query timed spans reconstructed from the stream — each with source, name, duration, and trace ids. Includes spans that are still OPEN (e.g. a debug step paused at a breakpoint) when onlyOpen is set.",
			"inputSchema": {
				"source": z.string().optional().describe("Emitting context."),
				"name": z.string().optional().describe("Span name, e.g. 'step', 'cdn', 'editor-window'."),
				"minDurationMs": z.number().optional().describe("Only spans that took at least this long."),
				"onlyOpen": z.boolean().optional().describe("Only spans with no close yet (in progress)."),
				"sinceMs": z.number().optional().describe("Only spans that started in the last N milliseconds."),
				"limit": z.number().optional().describe("Max rows, default 200.")
			}
		},
		"handler": (args) => ok(store.querySpans(args as QuerySpansInput))
	}));

	registerTool(server, defineTool({
		"name": "get_tree_state",
		"config": {
			"title": "Get tree state",
			"description": "Health snapshot of the whole hub tree: how many pages are linked, every context (source) seen with its last message and how long ago, and all currently-open spans. The one-call answer to 'what is the editor doing right now?'.",
			"inputSchema": {}
		},
		"handler": () => ok(store.treeState(devHub.linkCount()))
	}));

	registerTool(server, defineTool({
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
				"timeoutMs": z.number().optional().describe("Give up after this long (default 30000).")
			}
		},
		"handler": async (args) => {
			const input = args as WaitInput;
			const record = await store.waitFor({ ...input, "timeoutMs": input.timeoutMs ?? 30000 });

			return ok(record ?? { "timedOut": true });
		}
	}));

	return server;
}
