/** One tab's live architecture: its contexts, the channels between them, each hub's topology. */
import type { ToolsContext } from "./context.ts";
import { defineTool, fail, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";
import { resolveTab } from "../forward.ts";

export default ({ debugMcp }: ToolsContext) => [defineTool({
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
				"a": candidate.a,
				"b": candidate.b,
				...candidate.medium === undefined ? {} : { "medium": candidate.medium },
				"count": candidate.count,
				"bytes": candidate.bytes,
				"rate": arch.rate(candidate, now),
				"linked": candidate.linked,
				"interest": candidate.interest,
				"labels": labelsOf(candidate, 200),
				"recent": candidate.recent.slice(-50).map((sample) => ({ "ago": now - sample.t, "forward": sample.forward, "kind": sample.kind, "label": sample.label, "bytes": sample.bytes, ...sample.payload === undefined ? {} : { "payload": sample.payload } }))
			})));
		}

		return ok({
			"reporters": Object.fromEntries([...arch.reporters].map(([id, seen]) => [id, { "lastReportMsAgo": now - seen }])),
			// A medium only two contexts use is the edge between them (its `medium`), not a node.
			"nodes": [...arch.nodes.values()].filter((node) => !arch.media().has(node.id)).map((node) => ({ "id": node.id, "state": node.state, "instances": node.instances, "spawnCount": node.spawnCount, "label": node.spec.label, "container": node.spec.container, "reporters": [...node.reporters] })),
			"channels": channels.slice(0, limit).map((candidate) => ({
				"a": candidate.a,
				"b": candidate.b,
				...candidate.medium === undefined ? {} : { "medium": candidate.medium },
				"count": candidate.count,
				"bytes": candidate.bytes,
				"rate": arch.rate(candidate, now),
				"linked": candidate.linked,
				"errors": candidate.errors,
				"top": labelsOf(candidate, 8)
			})),
			"topology": Object.fromEntries([...arch.topology].map(([id, snapshot]) => [id, { "subscriptions": snapshot.subscriptions.length, "links": snapshot.links.map((link) => ({ "id": link.id, "peer": link.peerId ?? null })) }]))
		});
	}
})];
