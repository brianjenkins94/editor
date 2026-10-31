/**
 * What the editor tab's MCP tools are written against: each family (a folder here, named for it — debug, files, git, …)
 * is a `tools.ts` whose default export makes its tools from a ToolHost. A tool is util/mcp's own — `defineTool`, a zod
 * input shape, a handler answering with `ok` / `fail` — as debug-mcp's own tools are, so a tool is written one way
 * wherever it's served; page-tools.ts serves these from the tab (observability's page tools), and debug-mcp registers
 * them while the tab is connected.
 *
 * A tool is how an agent acts in the editor: unsaved buffers, the debugger at a stop, the Problems view, a preview's DOM,
 * a change by hunk, JSON an agent acts on. The terminal is for people, and no tool runs a command line, so an agent works
 * through the editor (an edit is a WorkspaceEdit, a commit is by hunk) rather than around it; what it would have run is
 * a tool to write (NEXT.md, *Parked*). Names are `<family>_<verb>`, the family its folder
 * (`files_read`, `editor_problems`), one action per tool: a tool that would take an `action` argument is one tool per
 * action, so the list reads as a table of contents. `tab` says which page serves a tool; `window`, which preview.
 */
import type { PageToolAsk } from "@brianjenkins94/observability";
import type { McpTool, ToolContext } from "@brianjenkins94/util/mcp/tool";

/** A tool, and how long a caller waits for it unless the call says (`timeoutMs`; default 30000). */
export interface EditorTool {
	"tool": McpTool;
	"timeoutMs"?: number;
}

/** What a family's tools are given. */
export interface ToolHost {
	/** Request `name` in this tab's tree, for as long as the caller waits (`signal`) — or `timeoutMs`, past which it says
	 *  `timeoutMessage` (the tool's own words, rather than the caller's generic timeout). */
	"request": (name: string, args: unknown, signal: AbortSignal, timeoutMs?: number, timeoutMessage?: string) => Promise<unknown>;
}

/** A family's `tools.ts`: its default export. */
export type ToolFamily = (host: ToolHost) => EditorTool[];

/** A tool's context in the tab: util/mcp's, and the questions the person has approved for this call (their keys). */
export type PageToolContext = ToolContext & { "approved": string[] };

/** Thrown by a tool to ask the person before it acts (observability's PageToolAsk): debug-mcp decides it — BERNARD,
 *  JUDICIAL — or asks, and the tool is called again with it among `approved`. `context.confirm` throws it too. */
export class Ask extends Error {
	public readonly ask: PageToolAsk["ask"];

	public constructor(ask: PageToolAsk["ask"]) {
		super(ask.message);
		this.ask = ask;
	}
}
