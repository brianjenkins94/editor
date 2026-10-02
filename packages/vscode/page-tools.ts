/**
 * The editor tab's own MCP tools — observability page tools, which debug-mcp registers while this tab is connected,
 * beside every page's `page_eval` / `page_query`:
 *
 * - the debugger, driven the way VS Code's debug UI does: the worker-pod answers `debug.sessions` / `debug.start` /
 *   `debug.breakpoints` (extensions/worker-pod/debug-control.ts), and each session its own
 *   `debug.session.<id>.step|state|stop`. Every session answer is the same shape — state, and while stopped the line,
 *   its code, the locals — plus what the program printed;
 * - the preview's cold-start transform race, provoked on demand (the node worker's `preview.provoke`);
 * - one Chrome DevTools Protocol command to a preview's page (the shell's `preview.cdp`, see preview-devtools.ts).
 *
 * Each requests from this tab's root hub, so it reaches only this tab's tree; a call the agent gives up on is cancelled
 * down the tree.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { PageTool } from "@brianjenkins94/observability";
import { createRpcClient } from "@brianjenkins94/hub";

/** A service that isn't up fails fast, instead of waiting out the whole call. */
const RESPONDER_MS = 3000;

const SESSION = { "type": "string", "description": "The session id (from debug_sessions or debug_start). Omit when exactly one session is running." };
const PROGRAM = { "type": "string", "description": "The file, absolute or relative to the workspace (e.g. src/index.ts). Default: the file open in the editor." };

function schema(properties: Record<string, unknown>, required: string[] = []): Record<string, unknown> {
	return { "type": "object", "properties": properties, ...required.length === 0 ? {} : { "required": required } };
}

export function editorPageTools(hub: Hub): PageTool[] {
	const rpc = createRpcClient(hub);

	/** Request `name` in this tab's tree, for as long as the caller waits (`signal`) — or `timeoutMs`, past which it says
	 *  `timeoutMessage` (the tool's own words, rather than the caller's generic timeout). */
	async function request(name: string, args: unknown, signal: AbortSignal, timeoutMs?: number, timeoutMessage?: string): Promise<unknown> {
		try {
			return await rpc.request(name, args, { "timeoutMs": Infinity, "waitForResponderMs": RESPONDER_MS, "signal": timeoutMs === undefined ? signal : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) });
		} catch (error) {
			if (error instanceof DOMException && error.name === "TimeoutError" && timeoutMessage !== undefined) {
				throw new Error(timeoutMessage, { "cause": error });
			}

			throw error;
		}
	}

	/** The session to act on: `session` if given, else this tab's only live one. */
	async function resolveSession(session: unknown, signal: AbortSignal): Promise<string> {
		if (typeof session === "string") {
			return session;
		}

		const live = await request("debug.sessions", undefined, signal) as { "session": string; "program": string; "state": string }[];

		if (live.length === 1) {
			return live[0]!.session;
		}

		throw new Error(live.length === 0
			? "no debug session — start one with debug_start"
			: "several debug sessions — pass one: " + live.map((entry) => `${entry.session} (${entry.program}, ${entry.state})`).join("; "));
	}

	return [{
		"name": "debug_start",
		"description": "Run a file under the editor's tsval debugger (a VS Code debug session, visible in its UI) and return where it first stops: { session, state, reason, line, code, locals, output }. Set breakpoints here or with debug_breakpoints first — with none it runs to the end (state: terminated). Policy-gated capability calls (fetch, fs, …) also stop it (reason: capability).",
		"inputSchema": schema({
			"program": { ...PROGRAM, "description": "The file to run, absolute or relative to the workspace (e.g. src/index.ts). Default: the file open in the editor." },
			"breakpoints": { "type": "array", "items": { "type": "number" }, "description": "1-based lines to break on in that file, replacing its existing breakpoints." },
			"timeoutMs": { "type": "number", "description": "How long to wait for the first stop (default 30000)." }
		}),
		"timeoutMs": 30000,
		"handler": async ({ program, breakpoints }, { signal }) => request("debug.start", { "program": program, "breakpoints": breakpoints }, signal)
	}, {
		"name": "debug_sessions",
		"description": "This tab's live tsval debug sessions: [{ session, name, program, state, reason, line, column, function, code }]. state is starting, running, stopped, idle (a React app mounted, waiting for events) or terminated.",
		"inputSchema": schema({}),
		"timeoutMs": 5000,
		"handler": async (_args, { signal }) => request("debug.sessions", undefined, signal)
	}, {
		"name": "debug_step",
		"description": "Resume a stopped session and return where it stops next (or that it ended): { state, reason, line, code, locals, output }. next = step over, stepIn = into a call, stepOut = to the caller, continue = to the next breakpoint; stepBack and reverseContinue travel back through earlier stops (tsval records them).",
		"inputSchema": schema({
			"action": { "type": "string", "enum": ["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue"] },
			"session": SESSION,
			"timeoutMs": { "type": "number", "description": "How long to wait for the next stop (default 30000)." }
		}, ["action"]),
		"timeoutMs": 30000,
		"handler": async ({ action, session, timeoutMs = 30000 }, { signal }) => {
			const id = await resolveSession(session, signal);

			return request(`debug.session.${id}.step`, { "action": action }, signal, Number(timeoutMs), `still running after ${String(timeoutMs)}ms — check back with debug_state`);
		}
	}, {
		"name": "debug_state",
		"description": "Where a session is now, without moving it: { state, reason, line, code, locals, output }.",
		"inputSchema": schema({ "session": SESSION }),
		"timeoutMs": 5000,
		"handler": async ({ session }, { signal }) => request(`debug.session.${await resolveSession(session, signal)}.state`, undefined, signal)
	}, {
		"name": "debug_breakpoints",
		"description": "Replace a file's breakpoints (VS Code's own, so they show in the editor and apply to running and future sessions). An empty list clears them.",
		"inputSchema": schema({
			"program": PROGRAM,
			"lines": { "type": "array", "items": { "type": "number" }, "description": "1-based line numbers." }
		}, ["lines"]),
		"timeoutMs": 5000,
		"handler": async ({ program, lines }, { signal }) => request("debug.breakpoints", { "program": program, "lines": lines }, signal)
	}, {
		"name": "debug_stop",
		"description": "End a debug session.",
		"inputSchema": schema({ "session": SESSION }),
		"timeoutMs": 10000,
		"handler": async ({ session }, { signal }) => request(`debug.session.${await resolveSession(session, signal)}.stop`, undefined, signal)
	}, {
		"name": "provoke_transform",
		"description": "Force the preview's in-browser Vite dev server through the cold-start transform race on demand, and report any transform that lost (came back 500). Requires a preview already started (run the terminal `vite` command once). Two modes: default (warm) restarts the in-process server each round — fast, but the worker's typescript stays hot; hardReset spawns a fresh CHILD worker per round (cold almostnode + ts) to reproduce the true first-load window — slower (a cold ts chunk per round, so use fewer rounds), needs cross-origin isolation. Returns { rounds, hardReset, provoked, failures[], transformErrors[] }. Use this instead of hand-driving cold boots to hunt the race.",
		"inputSchema": schema({
			"rounds": { "type": "number", "description": "Cold-restart + concurrent-transform cycles to run (default 10; use ~5 for hardReset, it's slower)." },
			"modules": { "type": "array", "items": { "type": "string" }, "description": "Module URLs to hammer each round, e.g. ['/src/App.tsx']. Default: the whole src/ graph." },
			"hardReset": { "type": "boolean", "description": "Spawn a fresh cold child worker per round (cold ts realm — the true first-load race) instead of an in-process warm restart. Default false." }
		}),
		"timeoutMs": 300000,
		"handler": async ({ rounds = 10, modules, hardReset = false }, { signal }) => request("preview.provoke", { "rounds": rounds, "modules": modules, "hardReset": hardReset }, signal)
	}, {
		"name": "preview_cdp",
		"description": "Send one Chrome DevTools Protocol command to the PREVIEWED APP's page (not the editor's — that's page_eval) and return its result. The editor answers through chobitsu, a JavaScript CDP implementation it adds to the preview's page on first use, so it runs in the app's own realm: Runtime.evaluate (params { expression, returnByValue: true }), DOM.getDocument / DOM.querySelector / DOM.getOuterHTML, CSS.*, DOMStorage.*, Storage.*, Page.*. Events (console messages, network activity) aren't returned — only the command's reply. The Debugger domain lists scripts but can't pause. Requires that preview to be open (run the app first).",
		"inputSchema": schema({
			"method": { "type": "string", "description": "The CDP method, e.g. 'Runtime.evaluate' or 'DOM.getDocument'." },
			"params": { "type": "object", "description": "The method's params, e.g. { expression: 'document.title', returnByValue: true }." },
			"port": { "type": "number", "description": "The preview's port (default 5173, the demo's) — its first window." },
			"window": { "type": "string", "description": "A preview window by its key, when a port has several: '5173' (its first), '5173~2' (its second), … Overrides port." }
		}, ["method"]),
		"timeoutMs": 30000,
		"handler": async ({ method, params, port, window }, { signal }) => {
			const target = window === undefined ? { "port": port ?? 5173 } : { "window": window };
			const reply = await request("preview.cdp", { ...target, "message": JSON.stringify({ "id": 1, "method": method, "params": params ?? {} }) }, signal);
			const { result, error } = JSON.parse(String(reply)) as { "result"?: unknown; "error"?: { "message"?: string } };

			if (error !== undefined) {
				throw new Error(String(method) + ": " + (error.message ?? JSON.stringify(error)));
			}

			return result;
		}
	}, {
		"name": "runs",
		"description": "What's running in the editor, and what ran lately: every terminal's runs — a SERVICE runs until stopped (a dev server: `vite`, `npm run dev`, with its preview port), a TASK runs to completion (a `node` script) — each with its id, title, cwd, the terminal it came from, state (running / exited / failed / stopped), start and end times and exit code. Pass `stop` with a run's id to stop it.",
		"inputSchema": schema({
			"stop": { "type": "string", "description": "A running run's id, to stop it." }
		}),
		"handler": async ({ stop }, { signal }) => {
			if (typeof stop === "string") {
				return { "stopped": await request("runs.stop", { "id": stop }, signal) };
			}

			return request("runs.list", undefined, signal);
		}
	}, {
		"name": "preview_profile",
		"description": "CPU-profile the PREVIEWED APP's page for a while (the JS Self-Profiling API, in that page's own realm) and return where its time went: the busiest functions by self time (selfMs) and with what they called (totalMs), each with its script url and line, plus idleMs and durationMs. A docked preview shares the editor's thread, so editor functions can appear too — the app's are the ones whose url is under /__virtual__/. Set `full` for the whole Chrome .cpuprofile as well (it can be large). Requires that preview to be open (run the app first); a page from before the editor served the profiling policy needs a reload.",
		"inputSchema": schema({
			"durationMs": { "type": "number", "description": "How long to sample (default 5000, at most 60000)." },
			"sampleIntervalMs": { "type": "number", "description": "How often to sample, in ms (default 10; the browser may round it up)." },
			"top": { "type": "number", "description": "How many functions to list (default 25)." },
			"full": { "type": "boolean", "description": "Include the whole .cpuprofile (Chrome DevTools' format) in the result." },
			"port": { "type": "number", "description": "The preview's port (default 5173, the demo's) — its first window." },
			"window": { "type": "string", "description": "A preview window by its key, when a port has several: '5173' (its first), '5173~2' (its second), … Overrides port." }
		}),
		"timeoutMs": 120000,
		"handler": async ({ durationMs, sampleIntervalMs, top, full, port, window }, { signal }) => {
			const target = window === undefined ? { "port": port ?? 5173 } : { "window": window };
			const result = await request("preview.profile", { ...target, "durationMs": durationMs, "sampleIntervalMs": sampleIntervalMs, "top": top }, signal, (Number(durationMs) || 5000) + 30_000) as { "profile": unknown; "summary": unknown };

			return full === true ? result : result.summary;
		}
	}];
}
