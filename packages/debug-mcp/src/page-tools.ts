/**
 * Page tools, live: a connected tab can define its own MCP tools (observability's page-tools.ts — a game's "state",
 * "divergence", "step"). This keeps the MCP server's tool list in step with them: it reads every tab's
 * `page_tools.<tab>` manifest and registers each tool with util/mcp's `updateTool` (which adds it to the live server
 * and notifies the client, tools/list_changed), forwarding calls to `tool.<name>.<tab>`. Each gets a `tab` argument,
 * like page_eval, for when several tabs are connected.
 *
 * Re-read when a tab announces a change (`page_tools.changed`) and when tabs come or go. A tool no longer served stays
 * registered (util/mcp has no removal) and answers that no connected tab serves it.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PageToolSpec } from "../../observability/src/page-tools.ts";
import type { DebugMcp } from "./server.ts";
import { defineTool, fail, ok, updateTool } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";
import { PAGE_TOOL, PAGE_TOOL_NAME, PAGE_TOOLS, PAGE_TOOLS_CHANGED } from "../../observability/src/page-tools.ts";
import { callTab } from "./forward.ts";

const REFRESH_MS = 200;
const CALL_MS = 30_000;

/** The raw zod shape for a tool's JSON Schema input (util's tools take a shape). An unusable schema: no arguments. */
function shapeOf(schema: Record<string, unknown>): Record<string, z.ZodType> {
	try {
		const parsed = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);

		return parsed instanceof z.ZodObject ? parsed.shape as Record<string, z.ZodType> : {};
	} catch {
		return {};
	}
}

/** The tool names already on `server` (debug-mcp's own), which a page may not take over. */
function toolNames(server: McpServer): Set<string> {
	// The SDK keeps registrations in a private map; util/mcp exposes no listing.
	return new Set(Object.keys((server as unknown as { "_registeredTools"?: Record<string, unknown> })._registeredTools ?? {}));
}

export interface PageToolSync {
	/** Re-read every connected tab's page tools now (what the triggers schedule). */
	"refresh": () => Promise<void>;
	"dispose": () => void;
}

/** Keep `server`'s page tools in step with the tabs linked to `debugMcp`. Call once debug-mcp's own tools are on it. */
export function syncPageTools(server: McpServer, debugMcp: DebugMcp): PageToolSync {
	const reserved = toolNames(server);
	const registered = new Map<string, string>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let links = debugMcp.linkCount();

	async function refresh(): Promise<void> {
		const specs = new Map<string, PageToolSpec>();

		for (const { tab } of await debugMcp.tabs(1000).catch(() => [])) {
			const served = await debugMcp.rpc.request(PAGE_TOOLS + "." + tab, undefined, { "timeoutMs": 2000, "waitForResponderMs": 300 }).catch(() => []) as PageToolSpec[];

			for (const spec of Array.isArray(served) ? served : []) {
				if (typeof spec?.name === "string" && PAGE_TOOL_NAME.test(spec.name) && !reserved.has(spec.name) && !specs.has(spec.name)) {
					specs.set(spec.name, spec);
				}
			}
		}

		for (const [name, spec] of specs) {
			const key = JSON.stringify(spec);

			if (registered.get(name) === key) {
				continue;
			}

			registered.set(name, key);
			updateTool(server, defineTool({
				"name": name,
				"config": {
					"title": name,
					"description": `${String(spec.description)} (Served by the connected page; pass \`tab\` when several are connected.)`,
					"inputSchema": { ...shapeOf(spec.inputSchema ?? {}), "tab": z.string().optional().describe("The tab (from list_tabs) serving this tool. Omit when one tab is connected.") }
				},
				"handler": async (args) => {
					const { tab, _approved: _ignored, ...rest } = (args ?? {}) as Record<string, unknown> & { "tab"?: string };

					try {
						return await ok(await callTab(debugMcp, PAGE_TOOL + "." + name, tab, rest, CALL_MS));
					} catch (error) {
						return fail(error instanceof Error ? error.message : String(error));
					}
				}
			}));
		}
	}

	function schedule(): void {
		clearTimeout(timer);
		timer = setTimeout(() => { void refresh(); }, REFRESH_MS);
		timer.unref?.();
	}

	const unsubscribe = debugMcp.hub.subscribe(PAGE_TOOLS_CHANGED, schedule);
	// Tabs coming or going. Only a change in how many are linked: discovering tabs itself changes subscriptions (and so
	// the topology), so reacting to every topology event would loop.
	const untap = debugMcp.hub.tap((event) => {
		if (event.type === "topology" && debugMcp.linkCount() !== links) {
			links = debugMcp.linkCount();
			schedule();
		}
	});

	schedule();

	return {
		"refresh": refresh,
		"dispose": () => {
			unsubscribe();
			untap();
			clearTimeout(timer);
		}
	};
}
