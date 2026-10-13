/**
 * The debugger, driven the way VS Code's debug UI does: the worker-pod answers `debug.sessions` / `debug.start` /
 * `debug.breakpoints` / `debug.explore` (extensions/worker-pod/debug-control.ts), and each session its own `debug.session.<id>.step|state|
 * stop`. Every session answer is the same shape — state, and while stopped the line, its code, the locals — plus what
 * the program printed.
 */
import type { ToolFamily, ToolHost } from "../host";
import { defineTool, ok } from "@brianjenkins94/util/mcp/tool";
import { z } from "zod";

const SESSION = z.string().optional().describe("The session id (from debug_list or debug_start). Omit when exactly one session is running.");
/** An ordering of the program's events to run again: debug_explore's `eventLoop`, with one outcome's `schedule`. */
const EVENT_LOOP = z.object({ "now": z.number(), "seed": z.number(), "schedule": z.array(z.number()).optional() });
const PROGRAM = z.string().optional().describe("The file, absolute or relative to the workspace (e.g. src/index.ts). Default: the file open in the editor.");

/** The session to act on: `session` if given, else this tab's only live one. */
async function resolveSession({ request }: ToolHost, session: unknown, signal: AbortSignal): Promise<string> {
	if (typeof session === "string") {
		return session;
	}

	const live = await request("debug.sessions", undefined, signal) as { "session": string; "program": string; "state": string }[];

	if (live.length === 1) {
		return live[0].session;
	}

	throw new Error(live.length === 0
		? "no debug session — start one with debug_start"
		: "several debug sessions — pass one: " + live.map((entry) => `${entry.session} (${entry.program}, ${entry.state})`).join("; "));
}

const debug: ToolFamily = (host) => [
	{
		"timeoutMs": 30000,
		"tool": defineTool({
			"name": "debug_start",
			"config": {
				"description": "Run a file under the editor's debugger — the one Run uses (run.debugger: tsval, or an interpreter an extension plugs in) — as a VS Code debug session, visible in its UI, and return where it first stops: { session, state, reason, line, code, locals, output } — and file, when that's another of the program's files (a breakpoint set with debug_breakpoints in a file it imports stops there). Set breakpoints here or with debug_breakpoints first — with none it runs to the end (state: terminated). Policy-gated capability calls (fetch, fs, …) also stop it (reason: capability).",
				"inputSchema": {
					"program": z.string().optional().describe("The file to run, absolute or relative to the workspace (e.g. src/index.ts). Default: the file open in the editor."),
					"breakpoints": z.array(z.number()).optional().describe("1-based lines to break on in that file, replacing its existing breakpoints."),
					"eventLoop": EVENT_LOOP.optional().describe("Run one ordering of the program's events again: debug_explore's eventLoop with an outcome's schedule (tsval only)."),
					"timeoutMs": z.number().optional().describe("How long to wait for the first stop (default 30000).")
				}
			},
			"handler": async ({ program, breakpoints, eventLoop }, { signal }) => ok(host.request("debug.start", { "program": program, "breakpoints": breakpoints, ...eventLoop === undefined ? {} : { "eventLoop": eventLoop } }, signal))
		})
	},
	{
		"timeoutMs": 120000,
		"tool": defineTool({
			"name": "debug_explore",
			"config": {
				"description": "Run a program once per ordering of its events (timers, promises, fetches settling) and return the distinct ways it can end: { runs, complete, outcomes: [{ output, crash, schedule, path, runs }], eventLoop }. To debug one outcome, pass debug_start eventLoop: { ...eventLoop, schedule: outcome.schedule }. tsval only; policy-gated calls must be allowed by a rule, since an explored run doesn't stop to ask.",
				"inputSchema": {
					"program": PROGRAM,
					"maxRuns": z.number().optional().describe("Stop after this many runs (complete: false if orderings were left).")
				}
			},
			"handler": async ({ program, maxRuns }, { signal }) => ok(host.request("debug.explore", { "program": program, ...maxRuns === undefined ? {} : { "maxRuns": maxRuns } }, signal, 120000))
		})
	},
	{
		"timeoutMs": 5000,
		"tool": defineTool({
			"name": "debug_list",
			"config": {
				"description": "This tab's live debug sessions (any debugger's but a preview's run): [{ session, name, program, state, reason, line, column, function, code }]. state is starting, running, stopped, idle (waiting on a request, its stdin or a timer — or an app's file, the app running in its preview) or terminated.",
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
				"description": "Resume a stopped session and return where it stops next (or that it ended): { state, reason, line, code, locals, output }. next = step over, stepIn = into a call, stepOut = to the caller, continue = to the next breakpoint; stepBack and reverseContinue travel back through earlier stops (tsval records them).",
				"inputSchema": {
					"action": z.enum(["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue"]),
					"session": SESSION,
					"timeoutMs": z.number().optional().describe("How long to wait for the next stop (default 30000).")
				}
			},
			"handler": async ({ action, session, timeoutMs = 30000 }, { signal }) => {
				const id = await resolveSession(host, session, signal);

				return ok(host.request(`debug.session.${id}.step`, { "action": action }, signal, Number(timeoutMs), `still running after ${String(timeoutMs)}ms — check back with debug_state`));
			}
		})
	},
	{
		"timeoutMs": 5000,
		"tool": defineTool({
			"name": "debug_state",
			"config": { "description": "Where a session is now, without moving it: { state, reason, line, code, locals, output }.", "inputSchema": { "session": SESSION } },
			"handler": async ({ session }, { signal }) => ok(host.request(`debug.session.${await resolveSession(host, session, signal)}.state`, undefined, signal))
		})
	},
	{
		"timeoutMs": 5000,
		"tool": defineTool({
			"name": "debug_breakpoints",
			"config": {
				"description": "Replace a file's breakpoints (VS Code's own, so they show in the editor and apply to running and future sessions). An empty list clears them.",
				"inputSchema": { "program": PROGRAM, "lines": z.array(z.number()).describe("1-based line numbers.") }
			},
			"handler": async ({ program, lines }, { signal }) => ok(host.request("debug.breakpoints", { "program": program, "lines": lines }, signal))
		})
	},
	{
		"timeoutMs": 10000,
		"tool": defineTool({
			"name": "debug_stop",
			"config": { "description": "End a debug session.", "inputSchema": { "session": SESSION } },
			"handler": async ({ session }, { signal }) => ok(host.request(`debug.session.${await resolveSession(host, session, signal)}.stop`, undefined, signal))
		})
	}
];

export default debug;
