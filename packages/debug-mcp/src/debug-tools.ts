/**
 * Debugger tools — drive a tsval debug session in the live editor the way VS Code's debug UI does, and read where it
 * stopped. They forward to the RPCs the editor's worker-pod serves (extensions/worker-pod/debug-control.ts): the pod
 * answers `debug.sessions` / `debug.start` / `debug.breakpoints` (reached through the tab's root, as
 * `debug.sessions.<tab>` and so on — see forward.ts), and each session answers its own
 * `debug.session.<id>.step|state|stop`, so an action reaches exactly the tab that owns the session. Every session answer
 * is the same shape — state, and while stopped the line, its code, the locals — plus what the program printed.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { DebugMcp } from "./server.ts";
import { defineTool, fail, ok, registerTool } from "@brianjenkins94/util/mcp/tool";

import { z } from "zod";
import { callFor, callTab, RESPONDER_MS } from "./forward.ts";

const ACTION = z.enum(["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue"]);
const SESSION = z.string().optional().describe("The session id (from debug_sessions or debug_start). Omit when exactly one session is running.");
const TAB = z.string().optional().describe("The editor tab (from list_tabs). Omit when one tab is connected.");

/** The session to act on: `session` if given, else the only live one in `tab` (or the only connected tab). */
export async function resolveSession(debugMcp: DebugMcp, session: string | undefined, tab: string | undefined): Promise<string> {
	if (session !== undefined) {
		return session;
	}

	const live = (await callTab(debugMcp, "debug.sessions", tab, undefined, 5000)) as { "session": string; "program": string; "state": string }[];

	if (live.length === 1) {
		return live[0].session;
	}

	throw new Error(live.length === 0
		? "no debug session — start one with debug_start"
		: "several debug sessions — pass one: " + live.map((entry) => `${entry.session} (${entry.program}, ${entry.state})`).join("; "));
}

/** The tool result for `run`: its value, or its error as a failed result. */
async function answer(run: () => Promise<unknown>): Promise<ReturnType<typeof fail>> {
	try {
		return await ok(await run());
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error));
	}
}

export function registerDebugTools(server: McpServer, debugMcp: DebugMcp): void {
	const { rpc } = debugMcp;

	registerTool(server, defineTool({
		"name": "debug_start",
		"config": {
			"title": "Start a debug session",
			"description": "Run a file under the editor's tsval debugger (a VS Code debug session, visible in its UI) and return where it first stops: { session, state, reason, line, code, locals, output }. Set breakpoints here or with debug_breakpoints first — with none it runs to the end (state: terminated). Policy-gated capability calls (fetch, fs, …) also stop it (reason: capability).",
			"inputSchema": {
				"program": z.string().optional().describe("The file to run, absolute or relative to the workspace (e.g. src/index.ts). Default: the file open in the editor."),
				"breakpoints": z.array(z.number()).optional().describe("1-based lines to break on in that file, replacing its existing breakpoints."),
				"tab": TAB,
				"timeoutMs": z.number().optional().describe("How long to wait for the first stop (default 30000).")
			}
		},
		"handler": (args) => answer(() => {
			const { program, breakpoints, tab, timeoutMs = 30000 } = args as { "program"?: string; "breakpoints"?: number[]; "tab"?: string; "timeoutMs"?: number };

			return callTab(debugMcp, "debug.start", tab, { "program": program, "breakpoints": breakpoints }, timeoutMs);
		})
	}));

	registerTool(server, defineTool({
		"name": "debug_sessions",
		"config": {
			"title": "List debug sessions",
			"description": "An editor tab's live tsval debug sessions: [{ session, name, program, state, reason, line, column, function, code }]. state is starting, running, stopped, idle (a React app mounted, waiting for events) or terminated.",
			"inputSchema": { "tab": TAB }
		},
		"handler": (args) => answer(() => callTab(debugMcp, "debug.sessions", (args as { "tab"?: string }).tab, undefined, 5000))
	}));

	registerTool(server, defineTool({
		"name": "debug_step",
		"config": {
			"title": "Step a debug session",
			"description": "Resume a stopped session and return where it stops next (or that it ended): { state, reason, line, code, locals, output }. next = step over, stepIn = into a call, stepOut = to the caller, continue = to the next breakpoint; stepBack and reverseContinue travel back through earlier stops (tsval records them).",
			"inputSchema": {
				"action": ACTION,
				"session": SESSION,
				"tab": TAB.describe("Only to find the session when it's omitted: the editor tab (from list_tabs)."),
				"timeoutMs": z.number().optional().describe("How long to wait for the next stop (default 30000).")
			}
		},
		"handler": (args) => answer(async () => {
			const { action, session, tab, timeoutMs = 30000 } = args as { "action": string; "session"?: string; "tab"?: string; "timeoutMs"?: number };

			return callFor(rpc, `debug.session.${await resolveSession(debugMcp, session, tab)}.step`, { "action": action }, timeoutMs, `still running after ${timeoutMs}ms — check back with debug_state`);
		})
	}));

	registerTool(server, defineTool({
		"name": "debug_state",
		"config": {
			"title": "Read a debug session",
			"description": "Where a session is now, without moving it: { state, reason, line, code, locals, output }.",
			"inputSchema": { "session": SESSION, "tab": TAB }
		},
		"handler": (args) => answer(async () => {
			const { session, tab } = args as { "session"?: string; "tab"?: string };

			return rpc.request(`debug.session.${await resolveSession(debugMcp, session, tab)}.state`, undefined, { "timeoutMs": 5000, "waitForResponderMs": RESPONDER_MS });
		})
	}));

	registerTool(server, defineTool({
		"name": "debug_breakpoints",
		"config": {
			"title": "Set breakpoints",
			"description": "Replace a file's breakpoints (VS Code's own, so they show in the editor and apply to running and future sessions). An empty list clears them.",
			"inputSchema": {
				"program": z.string().optional().describe("The file, absolute or relative to the workspace. Default: the file open in the editor."),
				"lines": z.array(z.number()).describe("1-based line numbers."),
				"tab": TAB
			}
		},
		"handler": (args) => answer(() => {
			const { program, lines, tab } = args as { "program"?: string; "lines": number[]; "tab"?: string };

			return callTab(debugMcp, "debug.breakpoints", tab, { "program": program, "lines": lines }, 5000);
		})
	}));

	registerTool(server, defineTool({
		"name": "debug_stop",
		"config": {
			"title": "Stop a debug session",
			"description": "End a debug session.",
			"inputSchema": { "session": SESSION, "tab": TAB }
		},
		"handler": (args) => answer(async () => {
			const { session, tab } = args as { "session"?: string; "tab"?: string };

			return rpc.request(`debug.session.${await resolveSession(debugMcp, session, tab)}.stop`, undefined, { "timeoutMs": 10000, "waitForResponderMs": RESPONDER_MS });
		})
	}));
}
