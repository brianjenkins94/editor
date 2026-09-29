/**
 * The MCP face of the debug-mcp — the four tools an agent uses to see what the live editor did WITHOUT a
 * screenshot: query_logs (point events), query_spans (timed operations, incl. still-open ones), get_tree_state
 * (which contexts are alive + what's running now), and wait_for (block until a matching record arrives, so the
 * agent synchronizes on a real event instead of polling).
 *
 * Tools are authored with @brianjenkins94/util/mcp's model (`defineTool` + `ok`), so they read and behave like
 * every other tool in that ecosystem (same result shape, same MRTR confirm context). We mount them onto an
 * McpServer we own rather than going through `serveMcp`, because this process ALSO runs the WebSocket collector
 * — serveMcp owns the process (its own stdio / Vite dev bridge), which leaves no room for the WS server; here
 * the two share one process and one store. The store tools are read-only; the page tools and the debugger tools
 * (debug-tools.ts) act on the live editor, which only links to debug-mcp in dev (localhost, or `?debug`).
 */
import type { DebugMcp } from "./server.ts";
import type { QueryLogsInput, QuerySpansInput, WaitInput } from "./store.ts";
import { registerDebugTools } from "./debug-tools.ts";
import { defineTool, fail, ok, registerTool } from "@brianjenkins94/util/mcp/tool";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const LEVEL = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
const KIND = z.enum(["log", "span-open", "span-close"]);

/** Build the MCP server exposing the debug-mcp's store. Connect it to a transport (stdio) to serve. */
export function createMcpServer(debugMcp: DebugMcp): McpServer {
	const server = new McpServer({ "name": "debug-mcp", "version": "0.0.0" });
	const { store } = debugMcp;

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
		"handler": () => ok(store.treeState(debugMcp.linkCount()))
	}));

	registerTool(server, defineTool({
		"name": "get_architecture",
		"config": {
			"title": "Get architecture",
			"description": "The live architecture of the editor: every context (hubs, workers, extension hosts, webviews, network endpoints) with its state, every channel between two of them (hub links and probed channels) with message counts, rates and top messages, and each hub's topology (links and the peer at the other end). Pass `channel` (a node id or 'a|b') for one channel's full message breakdown and recent traffic.",
			"inputSchema": {
				"channel": z.string().optional().describe("Node id (e.g. 'workbench') or 'a|b' pair to detail; omit for the overview."),
				"limit": z.number().int().positive().optional().describe("Max channels in the overview (default 40).")
			}
		},
		"handler": ({ channel, limit = 40 }: { "channel"?: string; "limit"?: number }) => {
			const { arch } = debugMcp;
			const now = Date.now();
			const channels = [...arch.channels.values()]
				.filter((candidate) => channel === undefined || candidate.id === channel || candidate.a === channel || candidate.b === channel || candidate.b + "|" + candidate.a === channel)
				.sort((x, y) => y.count - x.count);
			const labelsOf = (candidate: (typeof channels)[number], max: number) => [...candidate.labels.entries()]
				.sort(([, x], [, y]) => y.count - x.count)
				.slice(0, max)
				.map(([label, stats]) => ({ "label": label, ...stats }));

			if (channel !== undefined) {
				return ok(channels.map((candidate) => ({
					"a": candidate.a, "b": candidate.b, "count": candidate.count, "bytes": candidate.bytes, "rate": arch.rate(candidate, now),
					"linked": candidate.linked, "interest": candidate.interest, "labels": labelsOf(candidate, 200),
					"recent": candidate.recent.slice(-50).map((sample) => ({ "ago": now - sample.t, "forward": sample.forward, "kind": sample.kind, "label": sample.label, "bytes": sample.bytes }))
				})));
			}

			return ok({
				"reporters": Object.fromEntries([...arch.reporters].map(([id, seen]) => [id, { "lastReportMsAgo": now - seen }])),
				"nodes": [...arch.nodes.values()].map((node) => ({ "id": node.id, "state": node.state, "instances": node.instances, "spawnCount": node.spawnCount, "label": node.spec.label, "container": node.spec.container, "reporters": [...node.reporters] })),
				"channels": channels.slice(0, limit).map((candidate) => ({
					"a": candidate.a, "b": candidate.b, "count": candidate.count, "bytes": candidate.bytes, "rate": arch.rate(candidate, now),
					"linked": candidate.linked, "errors": candidate.errors, "top": labelsOf(candidate, 8)
				})),
				"topology": Object.fromEntries([...arch.topology].map(([id, snapshot]) => [id, { "subscriptions": snapshot.subscriptions.length, "links": snapshot.links.map((link) => ({ "id": link.id, "peer": link.peerId ?? null })) }]))
			});
		}
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

	// ── Live page tools ────────────────────────────────────────────────────────────────────────────--
	// These do NOT read the store; they FORWARD to a tool the connected page hosts (page.ts `serve`s them) and
	// return its live answer. This is "an MCP server hosted in the tab": the tab owns the logic + live app state,
	// the relay is a pipe. If no page is connected the rpc times out and the tool reports it, not a crash.

	registerTool(server, defineTool({
		"name": "page_eval",
		"config": {
			"title": "Evaluate in the page",
			"description": "Evaluate a JavaScript expression IN THE LIVE editor page and return its result (JSON-serialized). A Promise result is awaited. Answers questions the log stream can't — current URL/title, element counts, localStorage, live app state. Requires a connected page (dev, localhost-gated).",
			"inputSchema": {
				"expression": z.string().describe("A JS expression, e.g. `document.title` or `document.querySelectorAll('.monaco-editor').length`. May evaluate to a Promise (e.g. an async IIFE), which is awaited."),
				"timeoutMs": z.number().optional().describe("How long to wait for the result, including an awaited Promise (default 5000).")
			}
		},
		"handler": async (args) => {
			const { expression, timeoutMs = 5000 } = args as { "expression": string; "timeoutMs"?: number };

			try {
				return ok(await debugMcp.rpc.request("page_eval", { "expression": expression }, { "timeoutMs": timeoutMs }));
			} catch (error) {
				return fail(error instanceof Error ? error.message : String(error));
			}
		}
	}));

	registerTool(server, defineTool({
		"name": "page_query",
		"config": {
			"title": "Query the page DOM",
			"description": "Run a CSS selector in the LIVE editor page and return the match count plus a sample of each match's trimmed text. Requires a connected page.",
			"inputSchema": {
				"selector": z.string().describe("A CSS selector, e.g. '.monaco-editor' or '[role=tab]'."),
				"limit": z.number().optional().describe("Max sample entries to return (default 10).")
			}
		},
		"handler": async (args) => {
			const { selector, limit } = args as { "selector": string; "limit"?: number };

			try {
				return ok(await debugMcp.rpc.request("page_query", { "selector": selector, "limit": limit ?? 10 }, { "timeoutMs": 5000 }));
			} catch (error) {
				return fail(error instanceof Error ? error.message : String(error));
			}
		}
	}));

	registerTool(server, defineTool({
		"name": "provoke_transform",
		"config": {
			"title": "Provoke the preview transform race",
			"description": "Force the preview's in-browser Vite dev server through the cold-start transform race on demand, and report any transform that lost (came back 500). Requires a connected page with a preview already started (run the terminal `vite` command once). Two modes: default (warm) restarts the in-process server each round — fast, but the worker's typescript stays hot; hardReset spawns a fresh CHILD worker per round (cold almostnode + ts) to reproduce the true first-load window — slower (a cold ts chunk per round, so use fewer rounds), needs cross-origin isolation. Returns { rounds, hardReset, provoked, failures[], transformErrors[] }. Use this instead of hand-driving cold boots to hunt the race.",
			"inputSchema": {
				"rounds": z.number().optional().describe("Cold-restart + concurrent-transform cycles to run (default 10; use ~5 for hardReset, it's slower)."),
				"modules": z.array(z.string()).optional().describe("Module URLs to hammer each round, e.g. ['/src/App.tsx']. Default: the whole src/ graph."),
				"hardReset": z.boolean().optional().describe("Spawn a fresh cold child worker per round (cold ts realm — the true first-load race) instead of an in-process warm restart. Default false.")
			}
		},
		"handler": async (args) => {
			const { rounds, modules, hardReset } = args as { "rounds"?: number; "modules"?: string[]; "hardReset"?: boolean };

			try {
				return ok(await debugMcp.rpc.request("preview_provoke", { "rounds": rounds ?? 10, "modules": modules, "hardReset": hardReset ?? false }, { "timeoutMs": 300000 }));
			} catch (error) {
				return fail(error instanceof Error ? error.message : String(error));
			}
		}
	}));

	registerDebugTools(server, debugMcp);

	return server;
}
