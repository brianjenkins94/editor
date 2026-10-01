/**
 * Page tools, live: a connected tab can define its own MCP tools (observability's page-tools.ts — a game's "state",
 * "divergence", "step"). This keeps the MCP server's tool list in step with them: it reads every tab's
 * `page_tools.<tab>` manifest and registers each tool with util/mcp's `updateTool` (which adds it to the live server
 * and notifies the client, tools/list_changed), forwarding calls to `tool.<name>.<tab>`. Each gets a `tab` argument
 * for when several tabs serve it. A call waits as long as the call (`timeoutMs`) or the tool says (PageToolSpec), and
 * cancels the page's work when it gives up.
 *
 * Re-read when a tab announces a change (`page_tools.changed`) and when tabs come or go. A tool no connected tab serves
 * any more is removed (the client is told: tools/list_changed).
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { PageToolSpec } from "../../observability/src/page-tools.ts";
import type { DebugMcp } from "./server.ts";
import { defineTool, fail, ok, removeTool, toolNames, updateTool } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";
import { PAGE_TOOL, PAGE_TOOL_NAME, PAGE_TOOLS, PAGE_TOOLS_CHANGED } from "../../observability/src/page-tools.ts";
import { callTab } from "./forward.ts";

const REFRESH_MS = 200;
const CALL_MS = 30_000;
const GRACE_MS = 1000;

/** The raw zod shape for a tool's JSON Schema input (util's tools take a shape). An unusable schema: no arguments. */
function shapeOf(schema: Record<string, unknown>): Record<string, z.ZodType> {
	try {
		const parsed = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);

		return parsed instanceof z.ZodObject ? parsed.shape as Record<string, z.ZodType> : {};
	} catch {
		return {};
	}
}

export interface PageToolSync {
	/** Re-read every connected tab's page tools now (what the triggers schedule). */
	"refresh": () => Promise<void>;
	"dispose": () => void;
}

/** Keep `server`'s page tools in step with the tabs linked to `debugMcp`. Call once debug-mcp's own tools are on it. */
export function syncPageTools(server: McpServer, debugMcp: DebugMcp): PageToolSync {
	// debug-mcp's own tools, already on `server`: a page may not take one over.
	const reserved = new Set(toolNames(server));
	const registered = new Map<string, string>();
	let timer: ReturnType<typeof setTimeout> | undefined;
	let links = debugMcp.linkCount();

	/** Which tabs serve each tool: a call that names no tab goes to the one that does (an app's tools, in a preview,
	 *  alongside its editor tab). */
	const servedBy = new Map<string, string[]>();

	async function refresh(): Promise<void> {
		const specs = new Map<string, PageToolSpec>();
		// Built on the side and swapped in at once (synchronously): a call during a refresh sees the last complete picture.
		const serving = new Map<string, string[]>();

		for (const { tab } of await debugMcp.tabs(1000).catch(() => [])) {
			const served = await debugMcp.rpc.request(PAGE_TOOLS + "." + tab, undefined, { "timeoutMs": 2000, "waitForResponderMs": 300 }).catch(() => []) as PageToolSpec[];

			for (const spec of Array.isArray(served) ? served : []) {
				if (typeof spec?.name === "string" && PAGE_TOOL_NAME.test(spec.name) && !reserved.has(spec.name)) {
					if (!specs.has(spec.name)) {
						specs.set(spec.name, spec);
					}

					serving.set(spec.name, [...serving.get(spec.name) ?? [], tab]);
				}
			}
		}

		servedBy.clear();

		for (const [name, tabs] of serving) {
			servedBy.set(name, tabs);
		}

		for (const name of [...registered.keys()]) {
			if (!specs.has(name)) {
				removeTool(server, name);
				registered.delete(name);
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
					"description": `${String(spec.description)} (Served by a connected page; pass \`tab\` when several serve it.)`,
					"inputSchema": { ...shapeOf(spec.inputSchema ?? {}), "tab": z.string().optional().describe("The tab (from list_tabs) serving this tool. Omit when only one serves it.") }
				},
				"handler": async (args) => {
					const { tab, _approved: _ignored, ...rest } = (args ?? {}) as Record<string, unknown> & { "tab"?: string };
					const tabs = servedBy.get(name) ?? [];
					// The call's own timeout, else the tool's, else ours — and a moment more, so a tool that times out its own
					// work says so itself.
					const timeoutMs = (typeof rest["timeoutMs"] === "number" ? rest["timeoutMs"] : spec.timeoutMs ?? CALL_MS) + GRACE_MS;

					try {
						return await ok(await callTab(debugMcp, PAGE_TOOL + "." + name, tab ?? (tabs.length === 1 ? tabs[0] : undefined), rest, timeoutMs));
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
