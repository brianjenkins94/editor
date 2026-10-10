/**
 * Every debugger's sessions as hub RPC — tsval's, and any interpreter plugged in as `run.debugger` — so anything on the
 * hub tree (debug-mcp's debug_* tools, and so an agent) can drive a debug session the way VS Code's debug UI does, and
 * read where it stopped.
 *
 *   pod     `debug.sessions`                       → every live session's summary
 *   pod     `debug.start` { program?, breakpoints?, args?, eventLoop? } → starts a session and answers with its first stop
 *   pod     `debug.explore` { program, maxRuns? }  → every ordering of its events run: the distinct outcomes (tsval's `tsval.explore`)
 *   pod     `debug.breakpoints` { program?, lines }  → replaces a file's breakpoints (VS Code's own, so the UI shows them)
 *   pod     `rules.given` { program?, target } → what a rule gives the file's `target` (process.argv): { rule, values } | null
 *   pod     `rules.set` { previous?, rule? } → my policy changed by a rule editor: previous replaced by rule (or added, or removed)
 *   pod     `rules.list`                       → every rule, apart: { mine: { file, rules }, shared: { file, rules } } | null
 *   pod     `rules.placed` { program? }        → the rules placed in a file, where they are now: [{ whose, rule, status, line, endLine }]
 *   session `debug.session.<id>.step` { action }   → resumes, and answers with the NEXT stop (or the end)
 *   session `debug.session.<id>.state`             → where it is now
 *   session `debug.session.<id>.stop`              → ends it
 *   session `debug.session.<id>.decide` { choice, rule? } → at a capability stop: allow, skip or deny — each for this call, this run or always (allow-once / allow-run / allow-always, skip / skip-run / skip-always, deny / deny-run / deny-always), or
 *                                                     rule (saved in my policy, deciding it), then resumes — served for every debugger's sessions (capability-stops.ts)
 *   session `debug.session.<id>.setValue` { name, value } → at a stop: a variable set to a literal; the run goes on with it
 *   session `debug.session.<id>.pace` { pace }      → what a timer's wait costs from here on: real, or none (Skip Waits)
 *   session `debug.session.<id>.stdin` { data }     → input for the program's process.stdin (as the Debug Console sends it)
 *
 * A session is followed by a debug adapter tracker on its DAP messages, and driven with DAP's own requests — continue,
 * next, the steps, setVariable, the run contract's stdin (and pace, a virtual clock's) — through VS Code, so a step
 * from here shows in its UI too, whichever debugger it is. Per-session subjects route each action to exactly the pod that
 * owns the session, even with several editor tabs linked to debug-mcp.
 */
import type { Hub } from "@brianjenkins94/hub";
import { createRpcClient, serve } from "@brianjenkins94/hub";

import { given, placesOf, type Rule } from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";

import { loadEffectivePolicy, loadPolicyFiles, movePlace, replaceRule } from "../capabilities/silo-store";
import { appRootOf, runApp, runDebugger } from "./launch";

/** How a stopped session resumes: DAP's own requests. */
export type DebugAction = "continue" | "next" | "stepIn" | "stepOut" | "stepBack" | "reverseContinue";
const ACTIONS = new Set<string>(["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue"] satisfies DebugAction[]);

/** `starting` until the first stop; `idle` = waiting — on a request, its stdin or a timer — with no stop to step from (or,
 *  for an app's file, the app running in its page). */
export type DebugState = "starting" | "running" | "stopped" | "idle" | "terminated";

/** Where a session is — the answer to every session call. Location, code and locals only while stopped. */
export interface DebugOutcome {
	"session": string;
	"name": string;
	"program": string;
	"state": DebugState;
	/** Why it stopped: breakpoint, step, capability (a policy-gated call), … — or `app`: the file is an app's, which runs
	 *  in its page (its dev server started, its preview open), not stepped here. */
	"reason"?: string;
	/** The file it stopped in, when it's another of the program's files than `program` (MODULES.md). */
	"file"?: string;
	"line"?: number;
	"column"?: number;
	"function"?: string;
	/** The source line it stopped on. */
	"code"?: string;
	"locals"?: { "name": string; "value": string; "type": string }[];
	/** Its event loop at the stop, as the Variables view's Event loop scope shows it: the virtual clock, the pace, the
	 *  timers pending, the results waiting. */
	"eventLoop"?: { "name": string; "value": string; "type": string }[];
	/** What the program printed since the action began. */
	"output": string[];
}

/** A frame as DAP's stackTrace answers it — and tsval's `code`, the line it stopped on as it ran. */
interface Frame { "id": number; "name": string; "line": number; "column": number; "source"?: { "path"?: string }; "code"?: string }

/** A variable as DAP's variables answers it. */
interface Variable { "name": string; "value": string; "type"?: string; "variablesReference"?: number }

/** What the program printed since the action began, at most this many lines. */
const OUTPUT_LINES = 200;

/**
 * A debug session as its DAP messages say it is — any debugger's (tsval's, an interpreter plugged in as `run.debugger`):
 * followed by a debug adapter tracker, driven with DAP's own requests, and read — where it stopped, its locals — with
 * stackTrace, scopes and variables. A debugger that tells the run contract's `idle` is waiting with nothing to step from.
 */
class Session {
	public state: DebugState = "starting";
	/** Followed by a tracker on its DAP messages (a debugger in this extension host), else by what every host is told. */
	public tracked = false;
	private reason: string | undefined;
	/** A capability stop asked (the run contract's `ask`, just before it stops): the reason the next stop is. */
	private asking = false;
	private thread = 1;
	private output: string[] = [];
	private readonly waiters = new Set<() => void>();
	public readonly session: vscode.DebugSession;

	public constructor(session: vscode.DebugSession) {
		this.session = session;
	}

	private get program(): string {
		const program = this.session.configuration["program"];

		return typeof program === "string" ? program : "";
	}

	/** What the adapter told VS Code. */
	public sent(message: { "type"?: string; "event"?: string; "body"?: Record<string, unknown> }): void {
		if (message.type !== "event") {
			return;
		}

		switch (message.event) {
			case "stopped":
				this.asking = false;
				this.reason = typeof message.body?.["reason"] === "string" ? message.body["reason"] : undefined;
				this.thread = typeof message.body?.["threadId"] === "number" ? message.body["threadId"] : 1;
				this.settle("stopped");
				break;

			case "continued":
				this.state = "running";
				break;

			case "idle":
				this.settle("idle");
				break;

			case "ask":
				this.asking = true;
				break;

			case "terminated":
				this.settle("terminated");
				break;

			case "output": {
				const category = message.body?.["category"] ?? "console";
				const text = typeof message.body?.["output"] === "string" ? message.body["output"] : "";

				if (category === "stdout" || category === "stderr") {
					this.output.push(...text.replace(/\n$/u, "").split("\n"));
					this.output.splice(0, Math.max(0, this.output.length - OUTPUT_LINES));
				}

				break;
			}

			default:
				break;
		}
	}

	/** What VS Code asked the adapter: a resume — by its UI, by `act`, or an answer at a capability stop (`decide`) —
	 *  starts a new action. */
	public received(message: { "type"?: string; "command"?: string }): void {
		if (message.type === "request" && (ACTIONS.has(message.command ?? "") || message.command === "decide")) {
			this.state = "running";
			this.output = [];
		}
	}

	/** Stopped, as VS Code focusing its frame says (a session no tracker follows): on a capability call if it just asked. */
	public stoppedOn(thread: number): void {
		this.reason = this.asking ? "capability" : undefined;
		this.asking = false;
		this.thread = thread;
		this.settle("stopped");
	}

	/** Enter `state`, answering everyone waiting for the next stop. */
	public settle(state: DebugState): void {
		this.state = state;

		for (const waiter of [...this.waiters]) {
			waiter();
		}

		this.waiters.clear();
	}

	/** Where it is now. Location, code and locals only while stopped (asked of the adapter: stackTrace, scopes, variables). */
	public async outcome(): Promise<DebugOutcome> {
		const base = { "session": this.session.id, "name": this.session.name, "program": this.program, "state": this.state, "output": [...this.output] };

		if (this.state !== "stopped") {
			return base;
		}

		try {
			const { stackFrames } = await this.session.customRequest("stackTrace", { "threadId": this.thread, "startFrame": 0, "levels": 1 }) as { "stackFrames": Frame[] };
			const frame = stackFrames[0];

			if (frame === undefined) {
				return { ...base, ...this.reason === undefined ? {} : { "reason": this.reason } };
			}

			const { scopes } = await this.session.customRequest("scopes", { "frameId": frame.id }) as { "scopes": { "name": string; "variablesReference": number }[] };
			const variables = async (reference: number | undefined): Promise<{ "name": string; "value": string; "type": string }[]> => (reference === undefined || reference === 0 ? [] : ((await this.session.customRequest("variables", { "variablesReference": reference })) as { "variables": Variable[] }).variables.map(({ name, value, type }) => ({ "name": name, "value": value, "type": type ?? "" })));
			const loop = scopes.find(({ name }) => name === "Event loop");
			const file = frame.source?.path;
			const code = frame.code ?? (file === undefined ? undefined : (await textOf(vscode.Uri.file(file)).catch(() => "")).split("\n")[frame.line - 1]?.trim());

			return {
				...base,
				...this.reason === undefined ? {} : { "reason": this.reason },
				"line": frame.line,
				"column": frame.column,
				"function": frame.name,
				...file === undefined || file === this.program ? {} : { "file": file },
				...code === undefined ? {} : { "code": code },
				"locals": await variables(scopes[0]?.variablesReference),
				...loop === undefined ? {} : { "eventLoop": await variables(loop.variablesReference) }
			};
		} catch {
			return base; // (it went on, or ended, while it was asked)
		}
	}

	/** The outcome once it next stops, goes idle or ends — or `signal.reason` if the caller gives up first. */
	public next(signal: AbortSignal): Promise<DebugOutcome> {
		return new Promise((resolve, reject) => {
			const waiter = (): void => {
				signal.removeEventListener("abort", onAbort);
				resolve(this.outcome());
			};
			const onAbort = (): void => {
				this.waiters.delete(waiter);
				reject(signal.reason);
			};

			this.waiters.add(waiter);
			signal.addEventListener("abort", onAbort, { "once": true });
		});
	}

	/** Its outcome once it has left starting or running (now, if it has). */
	public settled(signal: AbortSignal): Promise<DebugOutcome> {
		return this.state === "starting" || this.state === "running" ? this.next(signal) : this.outcome();
	}

	/** Resume with `action` (DAP's own request) and answer with the next stop, idle or end. */
	public async act(action: DebugAction, signal: AbortSignal): Promise<DebugOutcome> {
		if (this.state !== "stopped") {
			throw new Error(`session is ${this.state}, not stopped` + (this.state === "idle" ? " (it's waiting — on a request, its stdin or a timer: set a breakpoint in a handler and use it)" : ""));
		}

		const next = this.next(signal);

		await this.session.customRequest(action, { "threadId": this.thread });

		// (a tracked session's resume is seen as it's sent; another's is known by having sent it)
		if (!this.tracked) {
			this.received({ "type": "request", "command": action });
		}

		return next;
	}

	/** At a stop, set `name` (a variable in its frame's first scope) to a literal: DAP's setVariable. */
	public async setValue(name: string, value: string): Promise<string> {
		if (this.state !== "stopped") {
			throw new Error("not stopped");
		}

		const { stackFrames } = await this.session.customRequest("stackTrace", { "threadId": this.thread, "startFrame": 0, "levels": 1 }) as { "stackFrames": Frame[] };
		const { scopes } = stackFrames[0] === undefined ? { "scopes": [] } : await this.session.customRequest("scopes", { "frameId": stackFrames[0].id }) as { "scopes": { "variablesReference": number }[] };
		const answer = await this.session.customRequest("setVariable", { "variablesReference": scopes[0]?.variablesReference ?? 0, "name": name, "value": value }) as { "value"?: string };

		return answer.value ?? value;
	}
}

/** Every session, by its id. */
const sessions = new Map<string, Session>();
/** `debug.start` calls waiting for the session their launch config marks. */
const pendingLaunches = new Map<string, (session: Session) => void>();

/** The session `id`, while it runs. */
export function controllable(id: string): Session | undefined {
	return sessions.get(id);
}

/** Follow every session (a tracker on its DAP messages), serving its calls on `hub` while it runs. */
function trackSessions(context: vscode.ExtensionContext, hub: Hub): void {
	/** Each session's calls, served until it ends. */
	const served = new Map<string, () => void>();

	/** Follow `debugSession` (once): serve its calls, and answer a `debug.start` waiting for it. */
	const follow = (debugSession: vscode.DebugSession): Session | undefined => {
		// (a production run is a preview's: nothing to step, and stopping it closes the preview)
		if (debugSession.type === "production") {
			return undefined;
		}

		const known = sessions.get(debugSession.id);

		if (known !== undefined) {
			return known;
		}

		const session = new Session(debugSession);
		const prefix = "debug.session." + debugSession.id + ".";
		const unserve = [
			serve(hub, prefix + "step", (args, { signal }) => {
				const action = (args as { "action"?: string } | undefined)?.action ?? "";

				if (!ACTIONS.has(action)) {
					throw new Error(`unknown action "${action}" — one of ${[...ACTIONS].join(", ")}`);
				}

				return session.act(action as DebugAction, signal);
			}),
			serve(hub, prefix + "state", () => session.outcome()),
			serve(hub, prefix + "stop", async () => {
				await vscode.debug.stopDebugging(debugSession);

				return session.outcome();
			}),
			serve(hub, prefix + "setValue", (args) => {
				const { name, value } = (args ?? {}) as { "name"?: unknown; "value"?: unknown };

				if (typeof name !== "string" || typeof value !== "string") {
					throw new TypeError("setValue takes { name, value }: a variable's name and a literal as code writes it");
				}

				return session.setValue(name, value);
			}),
			// (a debugger with a virtual clock — tsval's — answers it; another fails it)
			serve(hub, prefix + "pace", async (args) => {
				const { pace } = (args ?? {}) as { "pace"?: unknown };

				if (pace !== "real" && pace !== "fast") {
					throw new TypeError("pace takes { pace }: \"real\" (timers wait their delay) or \"fast\" (they don't)");
				}

				await debugSession.customRequest("pace", { "pace": pace });

				return null;
			}),
			serve(hub, prefix + "stdin", async (args) => {
				const { data } = (args ?? {}) as { "data"?: unknown };

				if (typeof data !== "string") {
					throw new TypeError("stdin takes { data }: the input, as a string");
				}

				await debugSession.customRequest("stdin", { "data": data });

				return null;
			})
		];
		const launchId = debugSession.configuration["__launchId"];

		sessions.set(debugSession.id, session);
		served.set(debugSession.id, () => { unserve.forEach((dispose) => { dispose(); }); });

		if (typeof launchId === "string") {
			pendingLaunches.get(launchId)?.(session);
			pendingLaunches.delete(launchId);
		}

		return session;
	};

	context.subscriptions.push(
		// A debugger in this extension host (tsval): every DAP message it sends and is sent — its stops, output, resumes.
		vscode.debug.registerDebugAdapterTrackerFactory("*", {
			"createDebugAdapterTracker": (debugSession) => {
				const session = follow(debugSession);

				if (session === undefined) {
					return undefined;
				}

				session.tracked = true;

				return {
					"onDidSendMessage": (message: { "type"?: string; "event"?: string; "body"?: Record<string, unknown> }) => { session.sent(message); },
					"onWillReceiveMessage": (message: { "type"?: string; "command"?: string }) => { session.received(message); }
				};
			}
		}),
		// One in another extension host (an extension loaded from outside the editor — editor-contrib's): no tracker sees it,
		// so it's followed by what VS Code tells every host — it started, the frame it stopped at, the run contract's custom
		// events, its end. Its output isn't told to other extensions: an agent sees none.
		vscode.debug.onDidStartDebugSession((debugSession) => { follow(debugSession); }),
		vscode.debug.onDidReceiveDebugSessionCustomEvent(({ session, event }) => {
			const followed = sessions.get(session.id);

			if (followed !== undefined && !followed.tracked) {
				followed.sent({ "type": "event", "event": event });
			}
		}),
		vscode.debug.onDidChangeActiveStackItem((item) => {
			const followed = item === undefined ? undefined : sessions.get(item.session.id);

			if (followed !== undefined && !followed.tracked && item !== undefined && "frameId" in item) {
				followed.stoppedOn(item.threadId);
			}
		}),
		// Ended (an inline adapter tells its tracker no exit): answered as ended, and no longer served.
		vscode.debug.onDidTerminateDebugSession((debugSession) => {
			sessions.get(debugSession.id)?.settle("terminated");
			sessions.delete(debugSession.id);
			served.get(debugSession.id)?.();
			served.delete(debugSession.id);
		})
	);
}

/** A path as the launch config wants it: absolute, relative ones under the first workspace folder; the active editor's
 *  file when omitted. */
function resolveProgram(program: string | undefined): string {
	const path = program ?? vscode.window.activeTextEditor?.document.uri.path;

	if (path === undefined || path === "") {
		throw new Error("no program — pass one (e.g. src/index.ts), or open the file in the editor");
	}

	if (path.startsWith("/")) {
		return path;
	}

	return (vscode.workspace.workspaceFolders?.[0]?.uri.path ?? "/workspace").replace(/\/$/u, "") + "/" + path;
}

/** What Run runs: a JavaScript or TypeScript file (RUNNING.md). */
const PROGRAM = /\.(?:m|c)?[jt]sx?$/u;

/** `path`, when it's a program Run can run; else why not. */
function runnable(path: string): string {
	if (!PROGRAM.test(path)) {
		throw new Error(`${path.split("/").pop()} isn't a program — Run runs a JavaScript or TypeScript file`);
	}

	return path;
}

/** Replace `program`'s breakpoints with `lines` (1-based), through VS Code so its UI and every session see them. */
function setBreakpoints(program: string, lines: number[]): void {
	const uri = vscode.Uri.file(program);
	const existing = vscode.debug.breakpoints.filter((breakpoint) => breakpoint instanceof vscode.SourceBreakpoint && breakpoint.location.uri.toString() === uri.toString());

	vscode.debug.removeBreakpoints(existing);
	vscode.debug.addBreakpoints(lines.map((line) => new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line - 1, 0)))));
}

/** Serve the pod-level calls (list, start, breakpoints) on `hub`. */
/** Where a placed rule's place is now: how it was found (or that it's lost), its 1-based lines, and — when that isn't its
 *  stored place (followed there through edits, moved, or re-placed by a match) — the reference as it would be made there
 *  now. */
interface PlaceNow { "status": string; "line"?: number; "endLine"?: number; "ref"?: unknown }

/** What `editor.annotations.resolve` answers for one reference. */
interface Found { "status"?: string; "candidate"?: { "start"?: number; "end"?: number; "file"?: string }; "ref"?: unknown }

/** How a place found surely enough to act on was found: on its own span, moved, or re-placed by a strong match. */
const SURE = new Set(["attached", "moved", "re-placed"]);

/** A workspace file's text as it is now: its open document's (edits not yet saved included), else what's on disk. */
async function textOf(uri: vscode.Uri): Promise<string> {
	const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());

	return open?.getText() ?? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

/** Where `place` is in `text` (of `file`), by the editor's BABLR — if in `file` at all. `before`: texts it may have been
 *  made against, for it to be followed from the one it was by the structural diff. */
async function resolvePlace(text: string, file: string, place: unknown, before: string[] = []): Promise<Found | undefined> {
	if (text === "") {
		return undefined; // nothing to find it in (and BABLR reads no empty text)
	}

	const [found] = await Promise.resolve(vscode.commands.executeCommand<(Found | undefined)[] | undefined>("editor.annotations.resolve", text, file, [place], { "texts": before })).catch(() => undefined) ?? [];

	return found?.status === undefined || found.status === "orphaned" || found.candidate?.start === undefined || (found.candidate.file !== undefined && found.candidate.file !== file) ? undefined : found;
}

/** How many of a file's latest edit bursts a placed rule is followed through. */
const HISTORY_STEPS = 30;

/** `place`, followed through `texts` (of `file`, oldest first) one at a time — each step from where it was last surely
 *  found, so an edit and the fix ESLint makes on save are two small steps rather than one jump too big to be sure of —
 *  to where it's surely found in the last (and how), or undefined if it isn't. It's followed from the latest text it's
 *  found in by its own span id (where it was placed, or unchanged since), so no lookalike from before then can take it. */
async function follow(place: unknown, texts: string[], file: string): Promise<{ "at": unknown; "found": Found } | undefined> {
	let from = texts.length - 1;

	while (from > 0 && (await resolvePlace(texts[from]!, file, place))?.status !== "attached") {
		from -= 1;
	}

	let at = place;
	let found: Found | undefined;

	for (let index = from; index < texts.length; index += 1) {
		// Each step from the texts before it — the reference was made against one of them — by the structural diff.
		found = await resolvePlace(texts[index]!, file, at, texts.slice(from, index));

		if (found !== undefined && SURE.has(found.status!) && found.ref !== undefined) {
			at = found.ref;
		}
	}

	return found !== undefined && SURE.has(found.status!) ? { "at": at, "found": found } : undefined;
}

/** Where each rule's place is now (RULES.md: *at*, a span reference) — followed through the edits made to its file since
 *  the last commit (the edit history's bursts, `history.texts`) to its text as it is now (unsaved edits included), or as
 *  saved (`saved`: for a place to be kept); looked for in it directly where it can't be followed surely (uncertain, or
 *  lost). Null for a rule with no place. The margin's marks, the Rules view and keeping places on save all see a rule
 *  where this finds it. */
async function placesNow(rpc: ReturnType<typeof createRpcClient>, rules: Rule[], saved = false): Promise<(PlaceNow | null)[]> {
	const root = vscode.workspace.workspaceFolders?.[0]?.uri;
	/** Each file's texts to follow through, read once for all its rules. */
	const textsOf = new Map<string, Promise<string[]>>();
	const texts = (file: string): Promise<string[]> => {
		const known = textsOf.get(file) ?? (async (): Promise<string[]> => {
			const uri = vscode.Uri.joinPath(root!, file);
			const now = saved ? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)) : await textOf(uri);
			const history = await rpc.request("history.texts", { "path": file }, { "timeoutMs": 10_000 }).catch(() => []) as string[];

			// The latest bursts (a long history needn't be walked from its start), ending at the text now — which the
			// history may not have caught up with yet.
			return [...history.slice(-HISTORY_STEPS), ...history.at(-1) === now ? [] : [now]];
		})();

		textsOf.set(file, known);

		return known;
	};

	return Promise.all(rules.map(async (rule) => {
		const [place] = placesOf(rule) as { "file"?: string }[];

		if (place === undefined || root === undefined || typeof place.file !== "string") {
			return null;
		}

		try {
			const chain = await texts(place.file);
			const text = chain.at(-1)!;
			const followed = await follow(place, chain, place.file);
			const found = followed?.found ?? await resolvePlace(text, place.file, place);

			if (found === undefined) {
				return { "status": "orphaned" };
			}

			const lineAt = (offset: number): number => text.slice(0, offset).split("\n").length;
			const { start, end } = found.candidate!;
			// The place it's at now, when that isn't the one stored: followed there, or found there by a match.
			const at = followed === undefined ? found.ref : followed.at === place ? undefined : followed.at;

			return { "status": found.status!, "line": lineAt(start!), "endLine": lineAt(end ?? start!), ...at === undefined ? {} : { "ref": at } };
		} catch {
			return { "status": "orphaned" };
		}
	}));
}

/** `rule` with its place (`at`'s argument) made `place`. */
function withPlace(rule: Rule, place: unknown): Rule {
	const walk = (predicate: Rule["when"]): Rule["when"] => ("predicates" in predicate ? { ...predicate, "predicates": predicate.predicates.map(walk) } : predicate.target_id === "at" && predicate.operator_id === "is" ? { ...predicate, "argument": place } : predicate) as Rule["when"];

	return { ...rule, "when": walk(rule.when) };
}

/** Each rule placed in `file` (workspace-relative) — mine and the shared contract's — followed to the file as saved
 *  (placesNow) and, surely found there somewhere other than its stored place (the statement moved, or changed but was
 *  followed or surely matched), kept at that place: its reference made again there, so it's found by its id from then
 *  on, rather than re-placed by hand (RULES.md). A shared rule's new place is a change to the contract, committed with
 *  the code change that moved its code. */
async function keepPlaces(rpc: ReturnType<typeof createRpcClient>, file: string): Promise<void> {
	const files = await loadPolicyFiles();
	const placed = (["mine", "shared"] as const).flatMap((whose) => (files?.[whose].rules ?? []).filter((rule) => (placesOf(rule) as { "file"?: string }[]).some((place) => place?.file === file)).map((rule) => ({ "whose": whose, "rule": rule })));

	if (placed.length === 0) {
		return;
	}

	const places = await placesNow(rpc, placed.map(({ rule }) => rule), true);

	for (const [index, { whose, rule }] of placed.entries()) {
		const place = places[index];

		if (place?.ref !== undefined && SURE.has(place.status)) {
			await movePlace(whose, rule, withPlace(rule, place.ref));
		}
	}
}

export function serveDebugControl(context: vscode.ExtensionContext, hub: Hub): void {
	const rpc = createRpcClient(hub);

	trackSessions(context, hub);

	context.subscriptions.push(
		// A file saved: my rules placed in it keep the places they're found at.
		vscode.workspace.onDidSaveTextDocument((document) => {
			if (document.uri.scheme === "file") {
				void keepPlaces(rpc, vscode.workspace.asRelativePath(document.uri, false)).catch(() => undefined);
			}
		}),
		{ "dispose": serve(hub, "debug.sessions", async () => Promise.all([...sessions.values()].map(async (session) => {
			const { output: _output, locals: _locals, ...summary } = await session.outcome();

			return summary;
		}))) },
		{ "dispose": serve(hub, "debug.breakpoints", (args) => {
			// (`program` is any file: a breakpoint in one the program loads stops there)
			const { program, lines } = (args ?? {}) as { "program"?: string; "lines"?: number[] };
			const path = resolveProgram(program);

			setBreakpoints(path, lines ?? []);

			return { "program": path, "lines": lines ?? [] };
		}) },
		// What a rule gives a file's process.argv, for the notes margin's Mock (RULES.md) — matched here, where the policy
		// is, so the workbench loads no policy engine to draw a row.
		{ "dispose": serve(hub, "rules.given", async (args) => {
			const { program, target } = (args ?? {}) as { "program"?: string; "target"?: string };
			const path = resolveProgram(program);

			return given(await loadEffectivePolicy(), { "program": vscode.workspace.asRelativePath(vscode.Uri.file(path), false) }, target ?? "process.argv") ?? null;
		}) },
		// Every rule, for the Rules view (rules-view.ts): mine, then the shared contract's — and where each placed rule's
		// place is now (its line, or that it's uncertain or lost).
		{ "dispose": serve(hub, "rules.list", async () => {
			const files = await loadPolicyFiles();

			if (files === undefined) {
				return null;
			}

			return { "mine": { ...files.mine, "places": await placesNow(rpc, files.mine.rules) }, "shared": { ...files.shared, "places": await placesNow(rpc, files.shared.rules) } };
		}) },
		// The rules placed in a file, for the notes margin's marks (live-values.ts): each one, whose it is, and where it
		// is in the file as it is now (its lines, or uncertain) — lost ones left out (the Rules view says so).
		{ "dispose": serve(hub, "rules.placed", async (args) => {
			const { program } = (args ?? {}) as { "program"?: string };
			const file = vscode.workspace.asRelativePath(vscode.Uri.file(resolveProgram(program)), false);
			const files = await loadPolicyFiles();
			const placed = (["mine", "shared"] as const).flatMap((whose) => (files?.[whose].rules ?? []).filter((rule) => (placesOf(rule) as { "file"?: string }[]).some((place) => place?.file === file)).map((rule) => ({ "whose": whose, "rule": rule })));
			const places = await placesNow(rpc, placed.map(({ rule }) => rule));

			return placed.flatMap(({ whose, rule }, index) => {
				const { status, line, endLine } = places[index] ?? {};

				return status === undefined || status === "orphaned" || line === undefined ? [] : [{ "whose": whose, "rule": rule, "status": status, "line": line, "endLine": endLine ?? line }];
			});
		}) },
		{ "dispose": serve(hub, "rules.set", async (args) => {
			const { previous, rule } = (args ?? {}) as { "previous"?: Rule; "rule"?: Rule };

			await replaceRule(previous, rule);

			return rule ?? null;
		}) },
		// Run (RUNNING.md): every button's, the margin's, an agent's — one path.
		{ "dispose": serve(hub, "debug.start", async (args, { signal }) => runProgram(args, signal)) },
		// Every ordering of a program's events, run (tsval's Explore Orderings, its command).
		{ "dispose": serve(hub, "debug.explore", async (args) => {
			const { program, maxRuns } = (args ?? {}) as { "program"?: string; "maxRuns"?: number };

			if (typeof program !== "string") {
				throw new TypeError("debug.explore: a program to explore");
			}

			return vscode.commands.executeCommand("tsval.explore", resolveProgram(program), maxRuns);
		}) }
	);
}

/** Run (RUNNING.md): `args.program` — the editor's file by default — as every way in runs it, answered with where it
 *  first stops, idles or ends. A run that can't start says why, in the workbench, whoever asked (a button's caller
 *  doesn't wait to show it). */
export async function runProgram(args: unknown, signal: AbortSignal = new AbortController().signal): Promise<DebugOutcome> {
	try {
		return await startRun(args, signal);
	} catch (error) {
		if (!signal.aborted) {
			void vscode.window.showErrorMessage(`Couldn't run: ${error instanceof Error ? error.message : String(error)}`);
		}

		throw error;
	}
}

/** Start a run of `args.program` (the editor's file by default) and answer with where it first stops, idles or ends. */
async function startRun(args: unknown, signal: AbortSignal): Promise<DebugOutcome> {
	const { program, breakpoints, "args": inputs, cases, eventLoop } = (args ?? {}) as { "program"?: string; "breakpoints"?: number[]; "args"?: string[]; "cases"?: string[][]; "eventLoop"?: unknown };
	const path = runnable(resolveProgram(program));
	// An app's file (RUNNING.md, step 4): its code runs in its page — the app runs, its dev server a run, its preview open.
	const app = await appRootOf(path);

	if (app !== undefined) {
		await runApp(app);

		return { "session": "", "name": path.split("/").pop()!, "program": path, "state": "idle", "reason": "app", "output": [] };
	}

	const launchId = crypto.randomUUID();

	// Before the launch, so they're registered by the time the session starts running.
	if (breakpoints !== undefined) {
		setBreakpoints(path, breakpoints);
	}

	// Whichever debugger Run starts (`run.debugger`: tsval, or another extension's) — followed the same way.
	const type = runDebugger();
	const launched = new Promise<Session>((resolve, reject) => {
		pendingLaunches.set(launchId, resolve);
		signal.addEventListener("abort", () => {
			pendingLaunches.delete(launchId);
			reject(signal.reason);
		}, { "once": true });
	});
	// `cases`: several runs, one after another (process.argv mocked with Multiple); answered with the first's first stop.
	const given = cases !== undefined && cases.length > 0 ? { "args": cases[0], "__cases": cases, "__case": 0 } : inputs === undefined ? {} : { "args": inputs };
	// `eventLoop`: an ordering to run again (debug.explore's: its clock, seed and schedule).
	const started = await vscode.debug.startDebugging(undefined, { "type": type, "request": "launch", "name": path.split("/").pop()!, "program": path, ...given, ...eventLoop === undefined ? {} : { "eventLoop": eventLoop }, "__launchId": launchId });

	if (!started) {
		pendingLaunches.delete(launchId);

		throw new Error(`VS Code didn't start a ${type} debug session`);
	}

	return (await launched).settled(signal);
}
