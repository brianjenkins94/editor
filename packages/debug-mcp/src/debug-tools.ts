/**
 * Debugger tools — drive a tsval debug session in the live editor the way VS Code's debug UI does, and read where it
 * stopped. They forward to the RPCs the editor's worker-pod serves (extensions/worker-pod/debug-control.ts): the pod
 * answers `debug.sessions` / `debug.start` / `debug.breakpoints`, and each session answers its own
 * `debug.session.<id>.step|state|stop`, so an action reaches exactly the tab that owns the session. Every session answer
 * is the same shape — state, and while stopped the line, its code, the locals — plus what the program printed.
 *
 * With several editor tabs connected, the list/start/breakpoints calls go to every tab that answers; keep one open.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RpcClient } from "@brianjenkins94/hub";
import type { DebugMcp } from "./server.ts";
import { defineTool, fail, ok, registerTool } from "@brianjenkins94/util/mcp/tool";

import { z } from "zod";

const ACTION = z.enum(["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue"]);
const SESSION = z.string().optional().describe("The session id (from debug_sessions or debug_start). Omit when exactly one session is running.");
// A page that isn't connected fails fast instead of waiting out the whole timeout.
const RESPONDER_MS = 3000;

/** The session to act on: `session` if given, else the only live one. */
export async function resolveSession(rpc: RpcClient, session: string | undefined): Promise<string> {
	if (session !== undefined) {
		return session;
	}

	const live = (await rpc.request("debug.sessions", undefined, { "timeoutMs": 5000, "waitForResponderMs": RESPONDER_MS })) as { "session": string; "program": string; "state": string }[];

	if (live.length === 1) {
		return live[0].session;
	}

	throw new Error(live.length === 0
		? "no debug session — start one with debug_start"
		: "several debug sessions — pass one: " + live.map((entry) => `${entry.session} (${entry.program}, ${entry.state})`).join("; "));
}

/** Call `name` with no ceiling but `timeoutMs`: past it the call is cancelled (the editor stops waiting too). */
async function callFor(rpc: RpcClient, name: string, args: unknown, timeoutMs: number): Promise<unknown> {
	try {
		return await rpc.request(name, args, { "timeoutMs": Infinity, "waitForResponderMs": RESPONDER_MS, "signal": AbortSignal.timeout(timeoutMs) });
	} catch (error) {
		if (error instanceof DOMException && error.name === "TimeoutError") {
			throw new Error(`still running after ${timeoutMs}ms — check back with debug_state`);
		}

		throw error;
	}
}

/** The tool result for `run`: its value, or its error as a failed result. */
async function answer(run: () => Promise<unknown>): Promise<Awaited<ReturnType<typeof ok>>> {
	try {
		return await ok(await run());
	} catch (error) {
		return await fail(error instanceof Error ? error.message : String(error));
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
				"timeoutMs": z.number().optional().describe("How long to wait for the first stop (default 30000).")
			}
		},
		"handler": (args) => answer(() => {
			const { program, breakpoints, timeoutMs = 30000 } = args as { "program"?: string; "breakpoints"?: number[]; "timeoutMs"?: number };

			return callFor(rpc, "debug.start", { "program": program, "breakpoints": breakpoints }, timeoutMs);
		})
	}));

	registerTool(server, defineTool({
		"name": "debug_sessions",
		"config": {
			"title": "List debug sessions",
			"description": "The editor's live tsval debug sessions: [{ session, name, program, state, reason, line, column, function, code }]. state is starting, running, stopped, idle (a React app mounted, waiting for events) or terminated.",
			"inputSchema": {}
		},
		"handler": () => answer(() => rpc.request("debug.sessions", undefined, { "timeoutMs": 5000, "waitForResponderMs": RESPONDER_MS }))
	}));

	registerTool(server, defineTool({
		"name": "debug_step",
		"config": {
			"title": "Step a debug session",
			"description": "Resume a stopped session and return where it stops next (or that it ended): { state, reason, line, code, locals, output }. next = step over, stepIn = into a call, stepOut = to the caller, continue = to the next breakpoint; stepBack and reverseContinue travel back through earlier stops (tsval records them).",
			"inputSchema": {
				"action": ACTION,
				"session": SESSION,
				"timeoutMs": z.number().optional().describe("How long to wait for the next stop (default 30000).")
			}
		},
		"handler": (args) => answer(async () => {
			const { action, session, timeoutMs = 30000 } = args as { "action": string; "session"?: string; "timeoutMs"?: number };

			return callFor(rpc, `debug.session.${await resolveSession(rpc, session)}.step`, { "action": action }, timeoutMs);
		})
	}));

	registerTool(server, defineTool({
		"name": "debug_state",
		"config": {
			"title": "Read a debug session",
			"description": "Where a session is now, without moving it: { state, reason, line, code, locals, output }.",
			"inputSchema": { "session": SESSION }
		},
		"handler": (args) => answer(async () => {
			const { session } = args as { "session"?: string };

			return rpc.request(`debug.session.${await resolveSession(rpc, session)}.state`, undefined, { "timeoutMs": 5000, "waitForResponderMs": RESPONDER_MS });
		})
	}));

	registerTool(server, defineTool({
		"name": "debug_breakpoints",
		"config": {
			"title": "Set breakpoints",
			"description": "Replace a file's breakpoints (VS Code's own, so they show in the editor and apply to running and future sessions). An empty list clears them.",
			"inputSchema": {
				"program": z.string().optional().describe("The file, absolute or relative to the workspace. Default: the file open in the editor."),
				"lines": z.array(z.number()).describe("1-based line numbers.")
			}
		},
		"handler": (args) => answer(() => {
			const { program, lines } = args as { "program"?: string; "lines": number[] };

			return rpc.request("debug.breakpoints", { "program": program, "lines": lines }, { "timeoutMs": 5000, "waitForResponderMs": RESPONDER_MS });
		})
	}));

	registerTool(server, defineTool({
		"name": "debug_stop",
		"config": {
			"title": "Stop a debug session",
			"description": "End a debug session.",
			"inputSchema": { "session": SESSION }
		},
		"handler": (args) => answer(async () => {
			const { session } = args as { "session"?: string };

			return rpc.request(`debug.session.${await resolveSession(rpc, session)}.stop`, undefined, { "timeoutMs": 10000, "waitForResponderMs": RESPONDER_MS });
		})
	}));
}
