/**
 * The editor's tools (host.ts) as observability page tools, which the tab serves and debug-mcp registers while it's
 * connected: a tool's zod input shape announced as JSON Schema (debug-mcp makes zod of it again), and its handler run
 * with the call's signal. Its answer is its ToolResult (`ok` / `fail`), which debug-mcp passes on as it is.
 *
 * Kept apart from index.ts (whose glob only Vite can read), so a test can serve a family's tools.
 */
import type { PageTool } from "@brianjenkins94/observability";
import type { Hub } from "@brianjenkins94/hub";
import type { ToolContext } from "@brianjenkins94/util/mcp/tool";
import type { EditorTool, ToolHost } from "./host";
import { createRpcClient } from "@brianjenkins94/hub";
import { z } from "zod";

/** A service that isn't up fails fast, instead of waiting out the whole call. */
const RESPONDER_MS = 3000;

/** What a page tool can't do: it runs in the tab, not in debug-mcp's server. */
const unavailable = (what: string) => async (): Promise<never> => { throw new Error(`a page tool can't ${what}`); };

/** The host this tab's tools get: requests into its root hub's tree. */
export function createToolHost(hub: Hub, { commands = "" }: { "commands"?: string } = {}): ToolHost {
	const rpc = createRpcClient(hub);

	return {
		"commands": commands,
		"request": async (name, args, signal, timeoutMs, timeoutMessage) => {
			try {
				return await rpc.request(name, args, { "timeoutMs": Infinity, "waitForResponderMs": RESPONDER_MS, "signal": timeoutMs === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
			} catch (error) {
				if (error instanceof DOMException && error.name === "TimeoutError" && timeoutMessage !== undefined) {
					throw new Error(timeoutMessage, { "cause": error });
				}

				throw error;
			}
		}
	};
}

/** `tools` as page tools. */
export function toPageTools(tools: EditorTool[]): PageTool[] {
	return tools.map(({ tool, timeoutMs }) => ({
		"name": tool.name,
		"description": tool.config.description,
		"inputSchema": z.toJSONSchema(z.object(tool.config.inputSchema as z.ZodRawShape)) as Record<string, unknown>,
		...timeoutMs === undefined ? {} : { "timeoutMs": timeoutMs },
		"handler": async (args, { signal }) => {
			const context: ToolContext = {
				"signal": signal,
				"elicit": unavailable("ask for input"),
				"confirm": unavailable("ask for confirmation"),
				"addTool": () => { throw new Error("a page tool can't add tools"); },
				"updateTool": () => { throw new Error("a page tool can't update tools"); },
				"progress": () => undefined,
				"confidence": () => undefined
			};

			return tool.handler(args, context);
		}
	}));
}
