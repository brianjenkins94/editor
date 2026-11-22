import type { PageToolAsk } from "@brianjenkins94/observability";
import type { McpTool, ToolContext } from "@brianjenkins94/util/mcp/tool";

export interface EditorTool {
	"tool": McpTool;
	"timeoutMs"?: number;
}

export interface ToolHost {
	"request": (name: string, args: unknown, signal: AbortSignal, timeoutMs?: number, timeoutMessage?: string) => Promise<unknown>;
}

export type ToolFamily = (host: ToolHost) => EditorTool[];

export type PageToolContext = ToolContext & { "approved": string[] };

export class Ask extends Error {
	public readonly ask: PageToolAsk["ask"];

	public constructor(ask: PageToolAsk["ask"]) {
		super(ask.message);
		this.ask = ask;
	}
}
