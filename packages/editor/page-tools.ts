/**
 * The editor tab's own MCP tools — observability page tools, which debug-mcp registers while this tab is connected,
 * beside every page's `page_eval` / `page_query`:
 *
 * - the debugger, driven the way VS Code's debug UI does: the worker-pod answers `debug.sessions` / `debug.start` /
 *   `debug.breakpoints` (extensions/worker-pod/debug-control.ts), and each session its own
 *   `debug.session.<id>.step|state|stop`. Every session answer is the same shape — state, and while stopped the line,
 *   its code, the locals — plus what the program printed;
 * - what a file's Margin tab shows, as data — the last run's values, coverage, its end, the question asked, notes, the run
 *   log (`margin.state`, live-values.ts) — rather than read off its DOM; likewise the editor's state, its problems and
 *   notifications (editor-state.ts), the rules (rules-view.ts), the terminals (terminal.ts), the preview windows
 *   (shell-preview.ts) and the run ledger (evidence.ts);
 * - the workspace, as an agent works in it — files read, written, edited, found and searched (`files.*`), a command run
 *   in its shell (`shell.run`, workspace-tools.ts), and git's status, diff and commit (git-service.ts);
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
		"description": "Run a file under the editor's debugger — the one Run uses (run.debugger: tsval, or an interpreter an extension plugs in) — as a VS Code debug session, visible in its UI, and return where it first stops: { session, state, reason, line, code, locals, output } — and file, when that's another of the program's files (a breakpoint set with debug_breakpoints in a file it imports stops there). Set breakpoints here or with debug_breakpoints first — with none it runs to the end (state: terminated). Policy-gated capability calls (fetch, fs, …) also stop it (reason: capability).",
		"inputSchema": schema({
			"program": { ...PROGRAM, "description": "The file to run, absolute or relative to the workspace (e.g. src/index.ts). Default: the file open in the editor." },
			"breakpoints": { "type": "array", "items": { "type": "number" }, "description": "1-based lines to break on in that file, replacing its existing breakpoints." },
			"timeoutMs": { "type": "number", "description": "How long to wait for the first stop (default 30000)." }
		}),
		"timeoutMs": 30000,
		"handler": async ({ program, breakpoints }, { signal }) => request("debug.start", { "program": program, "breakpoints": breakpoints }, signal)
	}, {
		"name": "debug_sessions",
		"description": "This tab's live debug sessions (any debugger's but a preview's run): [{ session, name, program, state, reason, line, column, function, code }]. state is starting, running, stopped, idle (waiting on a request, its stdin or a timer — or an app's file, the app running in its preview) or terminated.",
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
		"name": "margin",
		"description": "What a file's Margin tab shows beside its code (LIVE-VALUES.md), as data: the last run's values (each row's 1-based line, label and cells — a column per loop turn), what the bounds dropped, a capability stop's question, how the run ended, the marks in its gutter column (coverage, rules, the run's end), its cards, its notes and its run log. The file must be open in the editor.",
		"inputSchema": schema({ "file": { "type": "string", "description": "The file, absolute or relative to the workspace. Default: the file open in the editor." } }),
		"timeoutMs": 5000,
		"handler": async ({ file }, { signal }) => request("margin.state", { "file": file }, signal)
	}, {
		"name": "editor",
		"description": "What's in front of you in the editor, as data: the active file (its language, line count, whether it's unsaved), the cursor, any selections with their text, and the lines in view — all 1-based — and every editor tab open, by group.",
		"inputSchema": schema({}),
		"timeoutMs": 5000,
		"handler": async (_args, { signal }) => request("editor.state", undefined, signal)
	}, {
		"name": "problems",
		"description": "The Problems view, as data: each diagnostic's file, 1-based range, severity, source (ts, eslint, notes, a capability tripwire) and message — errors first. `total` says how many there are in all.",
		"inputSchema": schema({
			"file": { "type": "string", "description": "Only this file's (absolute or relative to the workspace)." },
			"limit": { "type": "number", "description": "At most this many (default 200)." }
		}),
		"timeoutMs": 5000,
		"handler": async ({ file, limit }, { signal }) => request("problems.list", { "file": file, "limit": limit }, signal)
	}, {
		"name": "files_read",
		"description": "Read a workspace file, numbered as `cat -n` numbers it (`line<TAB>text`): what's open in an editor — unsaved edits included — else what's on disk. Returns { path, lines (in all), from, to, dirty (unsaved edits), content }. Read a long file in pieces with offset and limit.",
		"inputSchema": schema({
			"path": { "type": "string", "description": "The file, relative to the workspace (src/index.ts) or absolute under it (/workspace/src/index.ts)." },
			"offset": { "type": "number", "description": "The 1-based line to start at (default 1)." },
			"limit": { "type": "number", "description": "Lines to read (default 2000)." }
		}, ["path"]),
		"timeoutMs": 10000,
		"handler": async ({ path, offset, limit }, { signal }) => request("files.read", { "path": path, "offset": offset, "limit": limit }, signal)
	}, {
		"name": "files_write",
		"description": "Make a workspace file, or replace its whole text. An open editor shows the change and undo takes it back, as if it were typed; then it's saved (format on save runs). Prefer files_edit to change part of a file. Returns { path, created, lines }.",
		"inputSchema": schema({
			"path": { "type": "string", "description": "The file, relative to the workspace or absolute under it. Its folders are made as needed." },
			"content": { "type": "string", "description": "The file's whole text." }
		}, ["path", "content"]),
		"timeoutMs": 15000,
		"handler": async ({ path, content }, { signal }) => request("files.write", { "path": path, "content": content }, signal)
	}, {
		"name": "files_edit",
		"description": "Replace an exact string in a workspace file — found once (else it fails: give more of the text around it), or every time with all. Matched against the file as the editor has it (unsaved edits included), whitespace and all — not files_read's line numbers. An open editor shows the change, undo takes it back; then it's saved. Returns { path, replaced }.",
		"inputSchema": schema({
			"path": { "type": "string", "description": "The file, relative to the workspace or absolute under it." },
			"old": { "type": "string", "description": "The exact text to replace." },
			"new": { "type": "string", "description": "What replaces it." },
			"all": { "type": "boolean", "description": "Replace every occurrence (default: there must be exactly one)." }
		}, ["path", "old", "new"]),
		"timeoutMs": 15000,
		"handler": async ({ path, old, "new": replacement, all }, { signal }) => request("files.edit", { "path": path, "old": old, "new": replacement, "all": all }, signal)
	}, {
		"name": "files_glob",
		"description": "The workspace's files a glob matches, relative to the workspace, sorted — node_modules and .git left out unless the glob names them. Returns { files, truncated }.",
		"inputSchema": schema({
			"pattern": { "type": "string", "description": "A glob: src/**/*.ts, **/package.json, *.md." },
			"limit": { "type": "number", "description": "At most this many (default 500)." }
		}, ["pattern"]),
		"timeoutMs": 15000,
		"handler": async ({ pattern, limit }, { signal }) => request("files.glob", { "pattern": pattern, "limit": limit }, signal)
	}, {
		"name": "files_grep",
		"description": "Search the workspace's files for a regular expression (JavaScript syntax), line by line — open files as the editor has them. Returns { matches: [{ file, line (1-based), text }], total }.",
		"inputSchema": schema({
			"pattern": { "type": "string", "description": "A regular expression, e.g. `function \\w+Run`." },
			"glob": { "type": "string", "description": "Only the files this glob matches (default: every file but node_modules and .git)." },
			"ignoreCase": { "type": "boolean", "description": "Match regardless of case." },
			"limit": { "type": "number", "description": "At most this many matches (default 200); total says how many there are." }
		}, ["pattern"]),
		"timeoutMs": 30000,
		"handler": async ({ pattern, glob, ignoreCase, limit }, { signal }) => request("files.grep", { "pattern": pattern, "glob": glob, "ignoreCase": ignoreCase, "limit": limit }, signal)
	}, {
		"name": "shell",
		"description": "Run a command line in the workspace's shell — just-bash on the workspace's files, as the terminal runs it: ls, cat, grep, sed, find, mkdir, mv, rm, echo > file; `node` runs a program in the debugger (its output here); `npm` installs and runs scripts. Each call is its own shell: cd and export don't carry over (pass cwd). Returns { exitCode, output (stdout and stderr, as printed), timedOut }.",
		"inputSchema": schema({
			"command": { "type": "string", "description": "The command line." },
			"cwd": { "type": "string", "description": "Where it runs, relative to the workspace or absolute under it (default /workspace)." },
			"timeoutMs": { "type": "number", "description": "Stop it after this long (default 120000)." }
		}, ["command"]),
		"timeoutMs": 600000,
		"handler": async ({ command, cwd, timeoutMs }, { signal }) => request("shell.run", { "command": command, "cwd": cwd, "timeoutMs": timeoutMs }, signal)
	}, {
		"name": "git",
		"description": "The workspace's git: status (each changed file — A, M or D — staged or not), diff (a unified diff of the working tree against the last commit: one file's, or every changed file's), or commit (a message, and every change, or the files given). Returns { files } for status, { diff } for diff, { oid } for commit.",
		"inputSchema": schema({
			"action": { "type": "string", "enum": ["status", "diff", "commit"], "description": "What to do." },
			"path": { "type": "string", "description": "diff: one file's (relative to the workspace)." },
			"message": { "type": "string", "description": "commit: its message." },
			"files": { "type": "array", "items": { "type": "string" }, "description": "commit: only these files (relative to the workspace); default, every change." }
		}, ["action"]),
		"timeoutMs": 60000,
		"handler": async ({ action, path, message, files }, { signal }) => {
			if (action === "status") {
				return request("git.status", undefined, signal);
			}

			if (action === "diff") {
				return request("git.diff", { "path": path }, signal);
			}

			if (action === "commit") {
				return request("git.commit", { "message": message, ...Array.isArray(files) ? { "files": files.map((file) => ({ "path": String(file) })) } : {} }, signal);
			}

			throw new Error(`unknown git action "${String(action)}" — status, diff or commit`);
		}
	}, {
		"name": "rules",
		"description": "Every rule, as the Rules view shows it (RULES.md): mine, then the shared contract's — each one's sentence, its JSON, the problem that makes it match nothing if there is one, and for a rule placed in the code where its place is now (its line, or that it's uncertain or lost).",
		"inputSchema": schema({}),
		"timeoutMs": 15000,
		"handler": async (_args, { signal }) => request("rules.state", undefined, signal)
	}, {
		"name": "notifications",
		"description": "The notifications showing now — the toasts and the notification center's: each one's severity, message, source and buttons. (Errors like \"Couldn't run: …\" appear only there.)",
		"inputSchema": schema({}),
		"timeoutMs": 5000,
		"handler": async (_args, { signal }) => request("notifications.list", undefined, signal)
	}, {
		"name": "terminal",
		"description": "The terminals, as data: each one's number, whether it's open, the command it runs (a task's terminal), its latest output (ANSI escapes stripped) and what it's running (its runs: id, title, state). Run a command in one with the editor's own terminal; read what it printed here.",
		"inputSchema": schema({
			"terminal": { "type": "number", "description": "Only this terminal (its number, from 1)." },
			"lines": { "type": "number", "description": "The latest this many lines of each one's output (default 50)." }
		}),
		"timeoutMs": 5000,
		"handler": async ({ terminal, lines }, { signal }) => request("terminal.state", { "terminal": terminal, "lines": lines }, signal)
	}, {
		"name": "previews",
		"description": "The preview windows open: each one's id (what preview_cdp and page_eval's frame take), its server's port and address, the page it's on, whether its page is popped out into a browser window of its own or has DevTools open, and when it was last used.",
		"inputSchema": schema({}),
		"timeoutMs": 5000,
		"handler": async (_args, { signal }) => request("preview.windows", undefined, signal)
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
		"name": "run_ledger",
		"description": "The run ledger (.silo/runs/<user>.jsonl, kept in git): every run that ended — terminal tasks and services, debug sessions, previews — each with its id, title, entry, start/end, exit, who and where it ran, the commit and the blob oid of each file it ran, and its effects: each gated call (capability fs:read / fs:write / net / exec / …, the resource it reached) with how it went — made, denied, skipped or given (a rule's result in its place) — and how many calls. Ask it what touched what: the runs with such an effect, and their effects added up ({ capability, resource, how, calls, runs, first, last }). Returns { total, runs (newest first), effects }.",
		"inputSchema": schema({
			"file": { "type": "string", "description": "Runs that ran this file — their entry, or any file they ran (repo-relative, e.g. src/index.ts)." },
			"capability": { "type": "string", "description": "Effects of this capability: fs:read, fs:write, net, exec, eval, net.ws, net.webrtc — or a family (fs)." },
			"resource": { "type": "string", "description": "Effects whose resource (a path, a host, a command) contains this." },
			"how": { "type": "string", "enum": ["made", "denied", "skipped", "given"], "description": "Effects that went this way." },
			"since": { "type": "string", "description": "Runs that ended at or after this ISO time." },
			"user": { "type": "string", "description": "One user's runs (the slug of their git identity)." },
			"limit": { "type": "number", "description": "Runs to return (default 20); the effects add up every run that matched." }
		}),
		"timeoutMs": 15000,
		"handler": async (query, { signal }) => request("runs.ledger", query, signal)
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
