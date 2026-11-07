/**
 * The debugger, driven as a person drives it: Run, the debug toolbar, the gutter's breakpoints, a stop's answers in the Margin
 * (the bridge's extensions/bridge/debug-control.ts). Every answer about a session is the same shape: its state, and while
 * stopped the line, its code and the locals, with what the program printed.
 */
import type { ToolFamily, ToolHost } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const SESSION = z.string().optional().describe("The session id (from debug_list or debug_start). Omit when exactly one is going.");
const PROGRAM = z.string().optional().describe("The file, absolute or relative to the workspace (src/index.ts, say). Default: the file open in the editor.");

/** The session to act on: `session`, else this tab's only one. */
async function sessionOf({ request }: ToolHost, session: unknown, signal: AbortSignal): Promise<string> {
	if (typeof session === "string") {
		return session;
	}

	const going = await request("debug.sessions", undefined, signal) as { "session": string; "program": string; "state": string }[];

	if (going.length === 1) {
		return going[0].session;
	}

	throw new Error(going.length === 0 ? "no debug session: start one with debug_start" : `several debug sessions, so pass one: ${going.map((each) => `${each.session} (${each.program}, ${each.state})`).join("; ")}`);
}

const debug: ToolFamily = (host) => [
	{
		"timeoutMs": 60000,
		"tool": defineTool({
			"name": "debug_start",
			"config": {
				"description": "Run a file as Run does, in the editor's debugger (a VS Code debug session, shown in its UI), and return where it first stops, idles or ends: { session, state, reason, line, code, locals, output }. A call the policy hasn't decided stops it with reason capability, its question in the Margin: answer with debug_decide.",
				"inputSchema": {
					"program": PROGRAM,
					"breakpoints": z.array(z.number()).optional().describe("1-based lines to break on in that file, replacing its breakpoints.")
				}
			},
			"handler": async ({ program, breakpoints }, { signal }) => ok(host.request("debug.start", { "program": program, "breakpoints": breakpoints }, signal, 60000))
		})
	},
	{
		"timeoutMs": 5000,
		"tool": defineTool({
			"name": "debug_list",
			"config": {
				"description": "The debug sessions going in this tab, as the Call Stack view lists them: [{ session, name, program, state, reason, line, function, code }]. state is starting, running, stopped, idle (waiting on a request, its stdin or a timer) or terminated. Runs after an edit aren't listed.",
				"inputSchema": {}
			},
			"handler": async (_args, { signal }) => ok(host.request("debug.sessions", undefined, signal))
		})
	},
	{
		"timeoutMs": 30000,
		"tool": defineTool({
			"name": "debug_step",
			"config": {
				"description": "Go on from a stop, as the debug toolbar does, and return where it stops next or that it ended: { state, reason, line, code, locals, output }. next steps over, stepIn into a call, stepOut to the caller, continue to the next breakpoint; stepBack and reverseContinue go back.",
				"inputSchema": {
					"action": z.enum(["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue"]),
					"session": SESSION,
					"timeoutMs": z.number().optional().describe("How long to wait for the next stop (default 30000).")
				}
			},
			"handler": async ({ action, session, timeoutMs = 30000 }, { signal }) => ok(host.request(`debug.session.${await sessionOf(host, session, signal)}.step`, { "action": action }, signal, Number(timeoutMs), `still running after ${String(timeoutMs)}ms: check with debug_state`))
		})
	},
	{
		"timeoutMs": 5000,
		"tool": defineTool({
			"name": "debug_state",
			"config": { "description": "Where a session is, without moving it, as the Call Stack and Variables views show it: { state, reason, line, code, locals, output }.", "inputSchema": { "session": SESSION } },
			"handler": async ({ session }, { signal }) => ok(host.request(`debug.session.${await sessionOf(host, session, signal)}.state`, undefined, signal))
		})
	},
	{
		"timeoutMs": 30000,
		"tool": defineTool({
			"name": "debug_decide",
			"config": {
				"description": "Answer the question a session stopped on (reason capability), as its buttons in the Margin do, and return where it stops next: allow lets the call run for real, skip doesn't make it, deny fails it. -once is this call (allow-once; skip and deny alone), -run every such call until the run ends, -always a rule in your policy.",
				"inputSchema": {
					"choice": z.enum(["allow-once", "allow-run", "allow-always", "skip", "skip-run", "skip-always", "deny", "deny-run", "deny-always"]),
					"session": SESSION
				}
			},
			"handler": async ({ choice, session }, { signal }) => ok(host.request(`debug.session.${await sessionOf(host, session, signal)}.decide`, { "choice": choice }, signal, 30000))
		})
	},
	{
		"timeoutMs": 5000,
		"tool": defineTool({
			"name": "debug_breakpoints",
			"config": {
				"description": "Replace a file's breakpoints, as the gutter does: VS Code's own, so they show in the editor and apply to sessions going and to come. An empty list clears them.",
				"inputSchema": { "program": PROGRAM, "lines": z.array(z.number()).describe("1-based line numbers.") }
			},
			"handler": async ({ program, lines }, { signal }) => ok(host.request("debug.breakpoints", { "program": program, "lines": lines }, signal))
		})
	},
	{
		"timeoutMs": 10000,
		"tool": defineTool({
			"name": "debug_stop",
			"config": { "description": "End a debug session, as the toolbar's Stop does.", "inputSchema": { "session": SESSION } },
			"handler": async ({ session }, { signal }) => ok(host.request(`debug.session.${await sessionOf(host, session, signal)}.stop`, undefined, signal))
		})
	}
];

export default debug;
