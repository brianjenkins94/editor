/**
 * What the editor tab's MCP tools are written against: each family (a folder here, named for it — debug, files, git, …)
 * is a `tools.ts` whose default export makes its tools from a ToolHost. A tool is util/mcp's own — `defineTool`, a zod
 * input shape, a handler answering with `ok` / `fail` — as debug-mcp's own tools are, so a tool is written one way
 * wherever it's served; page-tools.ts serves these from the tab (observability's page tools), and debug-mcp registers
 * them while the tab is connected.
 *
 * A tool is for what a command line can't give — unsaved buffers, the debugger at a stop, the Problems view, a preview's
 * DOM, JSON an agent acts on. Text in and text out is a terminal command instead, which an agent already reaches through
 * `terminal_run`, so a tool that wraps one is a duplicate. Names are `<family>_<verb>`, the family its folder
 * (`files_read`, `editor_problems`), one action per tool: a tool that would take an `action` argument is one tool per
 * action, so the list reads as a table of contents. `tab` says which page serves a tool; `window`, which preview.
 */
import type { McpTool } from "@brianjenkins94/util/mcp/tool";

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
	/** The terminal's own commands, as a sentence (terminal/catalog.ts, which only the Vite build can read). */
	"commands": string;
}

/** A family's `tools.ts`: its default export. */
export type ToolFamily = (host: ToolHost) => EditorTool[];
