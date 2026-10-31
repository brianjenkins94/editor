/**
 * Page tools: MCP tools a page defines and serves itself — a game's "state", "divergence", "step", the editor's
 * debugger, every page's `page_eval` — which debug-mcp registers as real MCP tools while a tab serving them is
 * connected. Everything a tab exposes to an agent is one of these.
 *
 * The wire, all on the tab's hub and addressed by its tab id (so a relay linked to several tabs reaches one):
 * - `page_tools.<tab>` (RPC) → the tab's `PageToolSpec[]`: name, description, JSON Schema input.
 * - `tool.<name>.<tab>` (RPC) → run tool `name` with the call's arguments; its result is the tool's answer.
 * - `page_tools.changed` (event, `{ tab }`) → the tab's set changed; re-read its manifest.
 *
 * A tool can ask the person before it acts (util/mcp's MRTR confirmation): it answers with a question (`PageToolAsk`)
 * instead of a result, and debug-mcp asks it of the agent's client, which re-invokes with the approval among the call's
 * `_approved` — handed to the tool as `approved`.
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
	/** How long a caller waits for the answer (ms) unless the call passes its own `timeoutMs`. Default 30000. */
	"timeoutMs"?: number;
}

export interface PageTool extends PageToolSpec {
	/** Runs in the page; its result must be structured-clonable / JSON-safe. `signal` aborts when the caller gives up
	 *  (its timeout, or it cancelled) — pass it on to anything the tool waits for. `approved`: the questions the person
	 *  has approved for this call (their keys). */
	"handler": (args: Record<string, unknown>, context: { "signal": AbortSignal; "approved": string[] }) => unknown;
}

/** A page tool's question for the person, answered in place of its result: `message` as they'll read it, `key` what
 *  their approval carries back (stable across calls). A gated call's also has its silo `scope` (`net:<host>`,
 *  `fs:write:<path>`, `exec:<program>`) and `request`, so debug-mcp decides it as util/mcp's broker does its own tools'
 *  calls — BERNARD's redline only as a deliberate break-glass, then JUDICIAL — before it asks. */
export interface PageToolAsk { "ask": { "message": string; "key": string; "scope"?: string; "request"?: Record<string, unknown> } }

/** The question in a page tool's answer, if that's what it is. */
export function askOf(answer: unknown): PageToolAsk["ask"] | undefined {
	const ask = typeof answer === "object" && answer !== null && "ask" in answer ? (answer as PageToolAsk).ask : undefined;

	return typeof ask?.message === "string" && typeof ask.key === "string" ? ask : undefined;
}

/** A tab's served page tools: unsubscribe all of it by calling it; `add` serves more (a page that learns what it is
 *  after it's observed — netsim's host, once its lobby says so). */
export type PageToolSet = (() => void) & { readonly "add": (tools: PageTool[]) => void };

/** Serve `tools` on `hub` as tab `tab`'s page tools, and announce them (and every change). */
export function servePageToolSet(hub: Hub, tab: string, tools: PageTool[]): PageToolSet {
	const specs: PageToolSpec[] = [];
	const disposers = [serve(hub, PAGE_TOOLS + "." + tab, () => specs)];
	const add = (more: PageTool[]): void => {
		for (const tool of more) {
			if (!PAGE_TOOL_NAME.test(tool.name)) {
				throw new Error(`page tool "${tool.name}": names are lowercase letters, digits and _ (starting with a letter)`);
			}
		}

		for (const { name, description, inputSchema, timeoutMs, handler } of more) {
			specs.push({ "name": name, "description": description, "inputSchema": inputSchema, ...timeoutMs === undefined ? {} : { "timeoutMs": timeoutMs } });
			disposers.push(serve(hub, PAGE_TOOL + "." + name + "." + tab, async (args, { signal }) => {
				const { "_approved": approved, ...rest } = (args ?? {}) as Record<string, unknown>;

				return handler(rest, { "signal": signal, "approved": Array.isArray(approved) ? approved.filter((key): key is string => typeof key === "string") : [] });
			}));
		}

		hub.publish(PAGE_TOOLS_CHANGED, { "tab": tab });
	};

	add(tools);

	return Object.assign(() => {
		for (const dispose of disposers) {
			dispose();
		}

		hub.publish(PAGE_TOOLS_CHANGED, { "tab": tab });
	}, { "add": add });
}
