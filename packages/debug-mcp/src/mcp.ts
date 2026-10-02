/**
 * The MCP face of the debug-mcp — the tools an agent uses to see what the live editor did WITHOUT a screenshot:
 * query_logs (point events), query_spans (timed operations, incl. still-open ones), query_metrics (the gauges sampled
 * once a second, and rates/errors/latencies derived from the spans), get_tree_state (which contexts are alive + what's
 * running now), and wait_for (block until a matching record arrives, so the agent synchronizes on a real event instead
 * of polling).
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
import { syncPageTools } from "./page-tools.ts";
import { resolveTab } from "./forward.ts";
import { defineTool, fail, ok, registerTool } from "@brianjenkins94/util/mcp/tool";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

const LEVEL = z.enum(["trace", "debug", "info", "warn", "error", "fatal"]);
const KIND = z.enum(["log", "span-open", "span-close"]);

/** Build the MCP server exposing the debug-mcp's store. Connect it to a transport (stdio) to serve. */
export function createMcpServer(debugMcp: DebugMcp): McpServer {
	const server = new McpServer({ "name": "debug-mcp", "version": "0.0.0" });
	const { store } = debugMcp;
	const TAB_FILTER = z.string().optional().describe("Only this tab's (from list_tabs). Each row names its tab: several tabs can have contexts of the same name.");

	/** The link a tab's records arrive on — asking the tabs if it isn't known yet. Throws for a tab that never connected. */
	async function linkFor(tab: string | undefined): Promise<string | undefined> {
		if (tab === undefined) {
			return undefined;
		}

		if (debugMcp.linkOf(tab) === undefined) {
			// Not learned yet (tabs map to links as they answer discovery): ask.
			await debugMcp.tabs();
		}

		const link = debugMcp.linkOf(tab);

		if (link === undefined) {
			throw new Error(`no tab "${tab}" has connected (list_tabs shows the ones that are)`);
		}

		return link;
	}

	/** Swap each row's link for its tab's id (asking the tabs once if a link's tab isn't known yet). */
	async function named<T extends { "link"?: string }>(rows: T[]): Promise<(Omit<T, "link"> & { "tab"?: string })[]> {
		if (rows.some((row) => row.link !== undefined && debugMcp.tabOf(row.link) === undefined)) {
			await debugMcp.tabs();
		}

		return rows.map(({ link, ...row }) => ({ ...row, ...link === undefined ? {} : { "tab": debugMcp.tabOf(link) ?? link } }));
	}

	/** Run a tool body that takes a `tab`, answering an unknown tab as the tool's error. */
	/** A preview app's tab rides its editor tab's link, so the link alone would give the editor's records too: narrow
	 *  to the app's own, by the scope it named (its window). */
	function scoped(tab: string | undefined): { "scope"?: string } {
		const scope = tab === undefined ? undefined : debugMcp.scopeOf(tab);

		return scope === undefined ? {} : { "scope": scope };
	}

	async function withTab(tab: string | undefined, body: (link: string | undefined) => ReturnType<typeof ok>): ReturnType<typeof ok> {
		let link: string | undefined;

		try {
			link = await linkFor(tab);
		} catch (error) {
			return fail(error instanceof Error ? error.message : String(error));
		}

		return body(link);
	}

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
				"limit": z.number().optional().describe("Max rows (most recent), default 200."),
				"tab": TAB_FILTER
			}
		},
		"handler": async (args) => {
			const { tab, ...input } = args as QueryLogsInput & { "tab"?: string };

			return withTab(tab, async (link) => ok(await named(store.queryLogs({ ...input, ...link === undefined ? {} : { "link": link }, ...scoped(tab) }))));
		}
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
				"limit": z.number().optional().describe("Max rows, default 200."),
				"tab": TAB_FILTER
			}
		},
		"handler": async (args) => {
			const { tab, ...input } = args as QuerySpansInput & { "tab"?: string };

			return withTab(tab, async (link) => ok(await named(store.querySpans({ ...input, ...link === undefined ? {} : { "link": link }, ...scoped(tab) }))));
		}
	}));

	registerTool(server, defineTool({
		"name": "get_tree_state",
		"config": {
			"title": "Get tree state",
			"description": "Health snapshot of the hub tree: how many pages are linked, every context (source) seen — per tab — with its last message and how long ago, and all currently-open spans. Pass `tab` for one tab's. The one-call answer to 'what is the editor doing right now?'.",
			"inputSchema": {
				"tab": TAB_FILTER
			}
		},
		"handler": async ({ tab }: { "tab"?: string }) => withTab(tab, async (link) => {
			const state = store.treeState(debugMcp.linkCount(), link);

			return ok({ ...state, "sources": await named(state.sources), "openSpans": await named(state.openSpans) });
		})
	}));

	registerTool(server, defineTool({
		"name": "get_architecture",
		"config": {
			"title": "Get architecture",
			"description": "The live architecture of one tab: every context (hubs, workers, extension hosts, webviews, network endpoints) with its state, every channel between two of them (hub links and probed channels) with message counts, rates and top messages, and each hub's topology (links and the peer at the other end). Pass `channel` (a node id or 'a|b') for one channel's full message breakdown and recent traffic.",
			"inputSchema": {
				"channel": z.string().optional().describe("Node id (e.g. 'workbench') or 'a|b' pair to detail; omit for the overview."),
				"limit": z.number().int().positive().optional().describe("Max channels in the overview (default 40)."),
				"tab": z.string().optional().describe("The tab (from list_tabs). Omit when one tab is connected.")
			}
		},
		"handler": async ({ channel, limit = 40, tab }: { "channel"?: string; "limit"?: number; "tab"?: string }) => {
			let resolved: string;

			try {
				resolved = await resolveTab(debugMcp, tab);
			} catch (error) {
				return fail(error instanceof Error ? error.message : String(error));
			}

			const arch = debugMcp.archOf(resolved);

			if (arch === undefined) {
				return fail(`tab ${resolved} hasn't reported its architecture yet`);
			}

			const now = Date.now();

			arch.sweep(now); // reporters gone silent are gone
			const channels = [...arch.channels.values()]
				.filter((candidate) => channel === undefined || candidate.id === channel || candidate.a === channel || candidate.b === channel || candidate.b + "|" + candidate.a === channel)
				.sort((x, y) => y.count - x.count);
			const labelsOf = (candidate: (typeof channels)[number], max: number) => [...candidate.labels.entries()]
				.sort(([, x], [, y]) => y.count - x.count)
				.slice(0, max)
				.map(([label, stats]) => ({ "label": label, ...stats }));

			if (channel !== undefined) {
				return ok(channels.map((candidate) => ({
					"a": candidate.a, "b": candidate.b, ...candidate.medium === undefined ? {} : { "medium": candidate.medium }, "count": candidate.count, "bytes": candidate.bytes, "rate": arch.rate(candidate, now),
					"linked": candidate.linked, "interest": candidate.interest, "labels": labelsOf(candidate, 200),
					"recent": candidate.recent.slice(-50).map((sample) => ({ "ago": now - sample.t, "forward": sample.forward, "kind": sample.kind, "label": sample.label, "bytes": sample.bytes, ...sample.payload === undefined ? {} : { "payload": sample.payload } }))
				})));
			}

			return ok({
				"reporters": Object.fromEntries([...arch.reporters].map(([id, seen]) => [id, { "lastReportMsAgo": now - seen }])),
				// A medium only two contexts use is the edge between them (its `medium`), not a node.
				"nodes": [...arch.nodes.values()].filter((node) => !arch.media().has(node.id)).map((node) => ({ "id": node.id, "state": node.state, "instances": node.instances, "spawnCount": node.spawnCount, "label": node.spec.label, "container": node.spec.container, "reporters": [...node.reporters] })),
				"channels": channels.slice(0, limit).map((candidate) => ({
					"a": candidate.a, "b": candidate.b, ...candidate.medium === undefined ? {} : { "medium": candidate.medium }, "count": candidate.count, "bytes": candidate.bytes, "rate": arch.rate(candidate, now),
					"linked": candidate.linked, "errors": candidate.errors, "top": labelsOf(candidate, 8)
				})),
				"topology": Object.fromEntries([...arch.topology].map(([id, snapshot]) => [id, { "subscriptions": snapshot.subscriptions.length, "links": snapshot.links.map((link) => ({ "id": link.id, "peer": link.peerId ?? null })) }]))
			});
		}
	}));

	registerTool(server, defineTool({
		"name": "query_metrics",
		"config": {
			"title": "Query metrics",
			"description": "The metrics plane of one tab: every context's gauges, sampled once a second — memory by realm (MB; the workbench's `memory.*`), the workspace file system's fill, long-frame share (%), hub messages/s, origin storage, and span metrics derived from every context's timed spans (`root:spans.SOURCE/NAME.rate`, `.errors`, `.p50`, `.p95`, `.open` — e.g. the service worker's CDN fetches as `sw/cdn`). Each series over the window: latest, min, max, mean; `points` adds the readings themselves.",
			"inputSchema": {
				"match": z.string().optional().describe("Only series whose `source:gauge` name contains this (case-insensitive), e.g. 'memory', 'spans', 'sw/cdn', 'errors'."),
				"source": z.string().optional().describe("Only this context's gauges, e.g. 'workbench', 'shell', 'root'."),
				"sinceMs": z.number().optional().describe("The window: the last N milliseconds (default 60000; up to five minutes are kept)."),
				"points": z.number().int().nonnegative().optional().describe("Also return each series' readings, thinned to at most this many ([msAgo, value], oldest first)."),
				"tab": z.string().optional().describe("The tab (from list_tabs). Omit when one tab is connected.")
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
	}));

	registerTool(server, defineTool({
		"name": "capture_payloads",
		"config": {
			"title": "Capture message payloads",
			"description": "Turn payload capture on or off in every connected tab: while on, each sampled message on every channel (hub links, workers, window messages, sockets, BroadcastChannels, Web Locks, WebRTC signaling and data channels) keeps a size-capped preview of what it carried — get_architecture with `channel` shows them in its recent traffic. Off by default: it records the app's data. Answers whether it's on.",
			"inputSchema": { "on": z.boolean().describe("true to capture, false to stop.") }
		},
		"handler": ({ on }: { "on": boolean }) => {
			debugMcp.capture(on);

			return ok({ "capturing": debugMcp.capturing() });
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
	}));

	// ── Live page tools ────────────────────────────────────────────────────────────────────────────--
	// These do NOT read the store; they FORWARD to a tool the connected tab hosts (servePageTools `serve`s them, under
	// the tab's id) and return its live answer. This is "an MCP server hosted in the tab": the tab owns the logic + live
	// app state, the relay is a pipe. Each call goes to ONE tab: the one named, or the only one connected (forward.ts).


	registerTool(server, defineTool({
		"name": "list_tabs",
		"config": {
			"title": "List editor tabs",
			"description": "The editor tabs connected right now: [{ tab, url, title, visible, focused }]. The page and debugger tools act on one tab — pass its `tab` when several are connected.",
			"inputSchema": {}
		},
		"handler": async () => ok(await debugMcp.tabs())
	}));

	// Everything a tab exposes — page_eval, page_query, the editor's debugger, a game's own — is a page tool, registered
	// while a tab serving it is connected. Last, so a page can't take over any of the tools above.
	syncPageTools(server, debugMcp);

	return server;
}
