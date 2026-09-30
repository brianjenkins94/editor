/**
 * Page tools: MCP tools a page defines and serves itself — a game's "state", "divergence", "step" — which debug-mcp
 * registers as real MCP tools while a tab serving them is connected.
 *
 * The wire, all on the tab's hub and addressed by its tab id (so a relay linked to several tabs reaches one):
 * - `page_tools.<tab>` (RPC) → the tab's `PageToolSpec[]`: name, description, JSON Schema input.
 * - `tool.<name>.<tab>` (RPC) → run tool `name` with the call's arguments; its result is the tool's answer.
 * - `page_tools.changed` (event, `{ tab }`) → the tab's set changed; re-read its manifest.
 */
import type { Hub } from "@brianjenkins94/hub";
import { serve } from "@brianjenkins94/hub";

export const PAGE_TOOLS = "page_tools";
export const PAGE_TOOLS_CHANGED = "page_tools.changed";
export const PAGE_TOOL = "tool";
/** A page tool's name: what an MCP client calls it by, so the MCP-safe subset (and no dots — it's a subject token). */
export const PAGE_TOOL_NAME = /^[a-z][\d_a-z]{0,63}$/u;

export interface PageToolSpec {
	"name": string;
	"description": string;
	/** JSON Schema for the arguments — an object schema (`{ type: "object", properties, required }`). */
	"inputSchema": Record<string, unknown>;
}

export interface PageTool extends PageToolSpec {
	/** Runs in the page; its result must be structured-clonable / JSON-safe. */
	"handler": (args: Record<string, unknown>) => unknown;
}

/** Serve `tools` on `hub` as tab `tab`'s page tools, and announce them. Returns an unsubscribe for all of it. */
export function servePageToolSet(hub: Hub, tab: string, tools: PageTool[]): () => void {
	for (const tool of tools) {
		if (!PAGE_TOOL_NAME.test(tool.name)) {
			throw new Error(`page tool "${tool.name}": names are lowercase letters, digits and _ (starting with a letter)`);
		}
	}

	const specs: PageToolSpec[] = tools.map(({ name, description, inputSchema }) => ({ "name": name, "description": description, "inputSchema": inputSchema }));
	const disposers = [
		serve(hub, PAGE_TOOLS + "." + tab, () => specs),
		...tools.map((tool) => serve(hub, PAGE_TOOL + "." + tool.name + "." + tab, async (args) => tool.handler((args ?? {}) as Record<string, unknown>)))
	];

	hub.publish(PAGE_TOOLS_CHANGED, { "tab": tab });

	return () => {
		for (const dispose of disposers) {
			dispose();
		}

		hub.publish(PAGE_TOOLS_CHANGED, { "tab": tab });
	};
}
