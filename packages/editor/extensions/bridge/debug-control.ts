/**
 * Every debugger's sessions as hub requests, so an agent (debug-mcp's debug_* tools) drives a run as a person does in the
 * editor: Run, the debug toolbar's steps and stop, the gutter's breakpoints, a stop's answers in the Margin. Each is done
 * through VS Code, so it shows in the editor as a person's would, whichever debugger it is.
 *
 *   `debug.sessions`                         every session going, where each is
 *   `debug.start` { program?, breakpoints? } Run: the file, answered with where it first stops, idles or ends
 *   `debug.breakpoints` { program?, lines }  a file's breakpoints replaced, VS Code's own
 *   `debug.session.<id>.step` { action }     a step, answered with the next stop, or the end
 *   `debug.session.<id>.state`               where it is now
 *   `debug.session.<id>.decide` { choice }   a stop's question answered, as its buttons in the Margin do; then the next stop
 *   `debug.session.<id>.stop`                ended
 *   `margin.state` { file? }                 what the Margin shows of a file
 *
 * A session is followed by a debug adapter tracker on its DAP messages and read with DAP's own requests (stackTrace, scopes,
 * variables). One subject per session sends each request to the tab whose session it is, with several tabs linked.
 */
import type { Hub } from "@brianjenkins94/hub";
import type { ObservedExtension } from "@brianjenkins94/editor-api/runtime";
import { serve } from "@brianjenkins94/hub";
import * as vscode from "vscode";

/** How a stopped session goes on: DAP's own requests, the toolbar's. */
export type DebugAction = "continue" | "next" | "stepIn" | "stepOut" | "stepBack" | "reverseContinue";
const ACTIONS = new Set<string>(["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue"] satisfies DebugAction[]);

/** `starting` until it first stops; `idle`, waiting on a request, its stdin or a timer with nothing to step from. */
export type DebugState = "starting" | "running" | "stopped" | "idle" | "terminated";

/** Where a session is: the answer to every request about one. Where it stopped, its code and its locals only while stopped. */
export interface DebugOutcome {
	"session": string;
	"name": string;
	"program": string;
	"state": DebugState;
	/** Why it stopped: breakpoint, step, capability (a call the policy hasn't decided, its question in the Margin), … */
	"reason"?: string;
	/** The file it stopped in, when it isn't `program`. */
	"file"?: string;
	"line"?: number;
	"column"?: number;
	"function"?: string;
	"code"?: string;
	"locals"?: { "name": string; "value": string; "type": string }[];
	/** What the program printed since the request began, its last lines. */
	"output": string[];
}

interface Frame { "id": number; "name": string; "line": number; "column": number; "source"?: { "path"?: string }; "code"?: string }

interface Variable { "name": string; "value": string; "type"?: string }

/** What the program printed since the request began, at most this many lines. */
const OUTPUT_LINES = 200;

/** A file's text as it is now: its open document's, edits not yet saved included, else what's on disk. */
async function textOf(uri: vscode.Uri): Promise<string> {
	const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());

	return open?.getText() ?? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

/** A debug session as its DAP messages say it is. */
class Session {
	public state: DebugState = "starting";
	public readonly session: vscode.DebugSession;
	private reason: string | undefined;
	/** A question asked (the run contract's `ask`, just before it stops): the reason the next stop is. */
	private asking = false;
	private thread = 1;
	private output: string[] = [];
	private readonly waiters = new Set<() => void>();

	public constructor(session: vscode.DebugSession) {
		this.session = session;
	}

	private get program(): string {
		const { program } = this.session.configuration;

		return typeof program === "string" ? program : "";
	}

	/** What the adapter told VS Code. */
	public sent(message: { "type"?: string; "event"?: string; "body"?: Record<string, unknown> }): void {
		if (message.type !== "event") {
			return;
		}

		switch (message.event) {
			case "stopped":
				this.reason = this.asking ? "capability" : typeof message.body?.["reason"] === "string" ? message.body["reason"] : undefined;
				this.asking = false;
				this.thread = typeof message.body?.["threadId"] === "number" ? message.body["threadId"] : 1;
				this.settle("stopped");
				break;

			case "continued":
			case "busy":
				this.state = "running";
				break;

			case "idle":
			case "serving":
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

				if (category === "stdout" || category === "stderr") {
					this.output.push(...String(message.body?.["output"] ?? "").replace(/\n$/u, "").split("\n"));
					this.output.splice(0, Math.max(0, this.output.length - OUTPUT_LINES));
				}

				break;
			}

			default:
				break;
		}
	}

	/** What VS Code asked the adapter: a step or an answer, by anyone, starts a new request's output. */
	public received(message: { "type"?: string; "command"?: string }): void {
		if (message.type === "request" && (ACTIONS.has(message.command ?? "") || message.command === "decide")) {
			this.state = "running";
			this.output = [];
		}
	}

	public settle(state: DebugState): void {
		this.state = state;

		for (const waiter of [...this.waiters]) {
			waiter();
		}

		this.waiters.clear();
	}

	/** Where it is now. */
	public async outcome(): Promise<DebugOutcome> {
		const base = { "session": this.session.id, "name": this.session.name, "program": this.program, "state": this.state, "output": [...this.output] };

		if (this.state !== "stopped") {
			return base;
		}

		try {
			const { stackFrames } = await this.session.customRequest("stackTrace", { "threadId": this.thread, "startFrame": 0, "levels": 1 }) as { "stackFrames": Frame[] };
			const [frame] = stackFrames;

			if (frame === undefined) {
				return { ...base, ...this.reason === undefined ? {} : { "reason": this.reason } };
			}

			const { scopes } = await this.session.customRequest("scopes", { "frameId": frame.id }) as { "scopes": { "variablesReference": number }[] };
			const reference = scopes[0]?.variablesReference ?? 0;
			const locals = reference === 0 ? [] : (await this.session.customRequest("variables", { "variablesReference": reference }) as { "variables": Variable[] }).variables.map(({ name, value, type }) => ({ "name": name, "value": value, "type": type ?? "" }));
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
				"locals": locals
			};
		} catch {
			return base; // (it went on, or ended, while it was asked)
		}
	}

	/** Where it is once it next stops, idles or ends; or `signal.reason`, if the caller gives up first. */
	public async next(signal: AbortSignal): Promise<DebugOutcome> {
		await new Promise<void>((resolve, reject) => {
			const waiter = (): void => {
				signal.removeEventListener("abort", onAbort);
				resolve();
			};
			const onAbort = (): void => {
				this.waiters.delete(waiter);
				reject(signal.reason as Error);
			};

			this.waiters.add(waiter);
			signal.addEventListener("abort", onAbort, { "once": true });
		});

		return this.outcome();
	}

	/** Where it is once it's no longer starting or running: now, if it isn't. */
	public async settled(signal: AbortSignal): Promise<DebugOutcome> {
		return this.state === "starting" || this.state === "running" ? this.next(signal) : this.outcome();
	}

	/** Go on with `action`, then where it stops next. */
	public async act(action: DebugAction, signal: AbortSignal): Promise<DebugOutcome> {
		if (this.state !== "stopped") {
			throw new Error(`the session is ${this.state}, not stopped${this.state === "idle" ? " (it's waiting on a request, its stdin or a timer: a breakpoint in what handles it stops it there)" : ""}`);
		}

		const next = this.next(signal);

		await this.session.customRequest(action, { "threadId": this.thread });

		return next;
	}

	/** Answer the question it stopped on, as the Margin's buttons do, then where it stops next. */
	public async decide(choice: string, signal: AbortSignal): Promise<DebugOutcome> {
		if (this.state !== "stopped" || this.reason !== "capability") {
			throw new Error("the session isn't stopped at a question");
		}

		const next = this.next(signal);

		await vscode.commands.executeCommand("margin.decide", this.session.id, choice);

		return next;
	}
}

/** A path as a launch wants it: absolute, a relative one under the workspace; the file in front when there's none. */
function resolveProgram(program: string | undefined): string {
	const path = program ?? vscode.window.activeTextEditor?.document.uri.path;

	if (path === undefined || path === "") {
		throw new Error("no program: pass one (src/index.ts, say), or open the file in the editor");
	}

	return path.startsWith("/") ? path : `${(vscode.workspace.workspaceFolders?.[0]?.uri.path ?? "/workspace").replace(/\/$/u, "")}/${path}`;
}

/** Replace `program`'s breakpoints with `lines` (1-based), through VS Code, so its gutter and every session have them. */
function setBreakpoints(program: string, lines: number[]): void {
	const uri = vscode.Uri.file(program);

	vscode.debug.removeBreakpoints(vscode.debug.breakpoints.filter((breakpoint) => breakpoint instanceof vscode.SourceBreakpoint && breakpoint.location.uri.toString() === uri.toString()));
	vscode.debug.addBreakpoints(lines.map((line) => new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line - 1, 0)))));
}

export function serveDebugControl(context: vscode.ExtensionContext, hub: Hub, log?: ObservedExtension["log"]): void {
	const sessions = new Map<string, Session>();
	/** `debug.start`s waiting for the session their launch is marked with. */
	const launches = new Map<string, (session: Session) => void>();
	/** Each session's requests, served until it ends. */
	const served = new Map<string, () => void>();

	const follow = (debugSession: vscode.DebugSession): Session | undefined => {
		// (a live run is nobody's to drive: RUNTIME-EVIDENCE.md, *Live runs*)
		if (debugSession.configuration["__live"] === true) {
			return undefined;
		}

		const known = sessions.get(debugSession.id);

		if (known !== undefined) {
			return known;
		}

		const session = new Session(debugSession);
		const prefix = `debug.session.${debugSession.id}.`;
		const unserve = [
			serve(hub, `${prefix}step`, async (args, { signal }) => {
				const action = (args as { "action"?: string } | undefined)?.action ?? "";

				if (!ACTIONS.has(action)) {
					throw new Error(`unknown action "${action}": one of ${[...ACTIONS].join(", ")}`);
				}

				return session.act(action as DebugAction, signal);
			}),
			serve(hub, `${prefix}state`, async () => session.outcome()),
			serve(hub, `${prefix}decide`, async (args, { signal }) => session.decide(String((args as { "choice"?: unknown } | undefined)?.choice ?? ""), signal)),
			serve(hub, `${prefix}stop`, async () => {
				await vscode.debug.stopDebugging(debugSession);

				return session.outcome();
			})
		];
		const launch = debugSession.configuration["__launchId"];

		sessions.set(debugSession.id, session);
		served.set(debugSession.id, () => {
			unserve.forEach((dispose) => {
				dispose();
			});
		});

		if (typeof launch === "string") {
			launches.get(launch)?.(session);
			launches.delete(launch);
		}

		return session;
	};

	/** Run `program` (the file in front by default), as Run does, and answer with where it first stops, idles or ends. */
	const start = async (program: string | undefined, breakpoints: number[] | undefined, signal: AbortSignal): Promise<DebugOutcome> => {
		const path = resolveProgram(program);

		if (!/\.[cm]?[jt]sx?$/u.test(path)) {
			throw new Error(`${path.split("/").pop() ?? path} isn't a program: Run runs a JavaScript or TypeScript file`);
		}

		// (before the launch, so they're there by the time it runs)
		if (breakpoints !== undefined) {
			setBreakpoints(path, breakpoints);
		}

		const launch = crypto.randomUUID();
		const launched = new Promise<Session>((resolve, reject) => {
			launches.set(launch, resolve);
			signal.addEventListener("abort", () => {
				launches.delete(launch);
				reject(signal.reason as Error);
			}, { "once": true });
		});

		// (what Run starts: tsval/run-file.ts' runOf)
		if (!await vscode.debug.startDebugging(undefined, { "type": "tsval", "request": "launch", "name": "Run", "program": path, "__launchId": launch })) {
			launches.delete(launch);

			throw new Error("VS Code didn't start the run");
		}

		return (await launched).settled(signal);
	};

	const span = async <T>(word: string, attributes: Record<string, string | number>, work: () => Promise<T>): Promise<T> => (log === undefined ? work() : log.span(`editor.extensions.bridge.debug-control.${word}`, attributes, work));

	context.subscriptions.push(
		vscode.debug.registerDebugAdapterTrackerFactory("*", {
			"createDebugAdapterTracker": (debugSession) => {
				const session = follow(debugSession);

				return session === undefined ? undefined : {
					"onDidSendMessage": (message: { "type"?: string; "event"?: string; "body"?: Record<string, unknown> }) => {
						session.sent(message);
					},
					"onWillReceiveMessage": (message: { "type"?: string; "command"?: string }) => {
						session.received(message);
					}
				};
			}
		}),
		// A run's end, from what every host is told (an inline adapter tells its tracker no exit).
		vscode.debug.onDidTerminateDebugSession((debugSession) => {
			sessions.get(debugSession.id)?.settle("terminated");
			sessions.delete(debugSession.id);
			served.get(debugSession.id)?.();
			served.delete(debugSession.id);
		}),
		// (one that's ended is gone, though VS Code may not have said so yet)
		{ "dispose": serve(hub, "debug.sessions", async () => Promise.all([...sessions.values()].filter(({ state }) => state !== "terminated").map(async (session) => {
			const { "output": _output, "locals": _locals, ...summary } = await session.outcome();

			return summary;
		}))) },
		{ "dispose": serve(hub, "debug.breakpoints", (args) => {
			const { program, lines = [] } = (args ?? {}) as { "program"?: string; "lines"?: number[] };
			const path = resolveProgram(program);

			setBreakpoints(path, lines);

			return { "program": path, "lines": lines };
		}) },
		{ "dispose": serve(hub, "debug.start", async (args, { signal }) => {
			const { program, breakpoints } = (args ?? {}) as { "program"?: string; "breakpoints"?: number[] };

			return span("start", { "caller": "agent", "path": program ?? "" }, async () => start(program, breakpoints, signal));
		}) },
		{ "dispose": serve(hub, "margin.state", async (args) => vscode.commands.executeCommand("margin.state", resolveProgram((args as { "file"?: string } | undefined)?.file))) }
	);
}
