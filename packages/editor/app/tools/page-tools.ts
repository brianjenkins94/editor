import type { Hub } from "@brianjenkins94/hub";
import type { PageTool } from "@brianjenkins94/observability";
import type { EditorTool, PageToolContext, ToolHost } from "./host";
import { createRpcClient } from "@brianjenkins94/hub";
import { z } from "zod";
import { Ask } from "./host";

const RESPONDER_MS = 3000;

const unavailable = (what: string) => (): Promise<never> => Promise.reject(new Error(`a page tool can't ${what}`));

export function createToolHost(hub: Hub): ToolHost {
	const rpc = createRpcClient(hub);

	return {
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

export function toPageTools(tools: EditorTool[]): PageTool[] {
	return tools.map(({ tool, timeoutMs }) => ({
		"name": tool.name,
		"description": tool.config.description,
		"inputSchema": z.toJSONSchema(z.object(tool.config.inputSchema as z.ZodRawShape)),
		...timeoutMs === undefined ? {} : { "timeoutMs": timeoutMs },
		"handler": async (args, { signal, approved }) => {
			const context: PageToolContext = {
				"signal": signal,
				"approved": approved,
				"elicit": unavailable("ask for input"),
				"confirm": async (message, key = message) => {
					if (approved.includes(key)) {
						return true;
					}

					throw new Ask({ "message": message, "key": key });
				},
				"addTool": () => { throw new Error("a page tool can't add tools"); },
				"updateTool": () => { throw new Error("a page tool can't update tools"); },
				"progress": () => undefined,
				"confidence": () => undefined
			};

			try {
				return await tool.handler(args, context);
			} catch (error) {
				if (error instanceof Ask) {
					return { "ask": error.ask };
				}

				throw error;
			}
		}
	}));
}
