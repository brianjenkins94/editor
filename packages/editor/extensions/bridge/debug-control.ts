import type { Hub } from "@brianjenkins94/hub";
import type { ObservedExtension } from "@brianjenkins94/editor-api/runtime";
import { runDebugger } from "@brianjenkins94/editor-api/debugger";
import { serve } from "@brianjenkins94/hub";
import * as vscode from "vscode";

export type DebugAction = "continue" | "next" | "stepIn" | "stepOut" | "stepBack" | "reverseContinue";
const ACTIONS = new Set<string>(["continue", "next", "stepIn", "stepOut", "stepBack", "reverseContinue"] satisfies DebugAction[]);

export type DebugState = "starting" | "running" | "stopped" | "idle" | "terminated";

export interface DebugOutcome {
	"session": string;
	"name": string;
	"program": string;
	"state": DebugState;
	"reason"?: string;
	"file"?: string;
	"line"?: number;
	"column"?: number;
	"function"?: string;
	"code"?: string;
	"locals"?: { "name": string; "value": string; "type": string }[];
	"output": string[];
}

interface Frame { "id": number; "name": string; "line": number; "column": number; "source"?: { "path"?: string }; "code"?: string }

interface Variable { "name": string; "value": string; "type"?: string }

const OUTPUT_LINES = 200;

const ENDED_KEPT = 200;

async function textOf(uri: vscode.Uri): Promise<string> {
	const open = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString());

	return open?.getText() ?? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
}

class Session {
	public state: DebugState = "starting";
	public readonly session: vscode.DebugSession;
	public tracked = false;
	private reason: string | undefined;
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

	public received(message: { "type"?: string; "command"?: string }): void {
		if (message.type === "request" && (ACTIONS.has(message.command ?? "") || message.command === "decide")) {
			this.state = "running";
			this.output = [];
		}
	}

	public stoppedOn(thread: number): void {
		this.reason = this.asking ? "capability" : undefined;
		this.asking = false;
		this.thread = thread;
		this.settle("stopped");
	}

	public settle(state: DebugState): void {
		this.state = state;

		for (const waiter of [...this.waiters]) {
			waiter();
		}

		this.waiters.clear();
	}

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
			return base;
		}
	}

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

	public async settled(signal: AbortSignal): Promise<DebugOutcome> {
		return this.state === "starting" || this.state === "running" ? this.next(signal) : this.outcome();
	}

	public async act(action: DebugAction, signal: AbortSignal): Promise<DebugOutcome> {
		if (this.state !== "stopped") {
			throw new Error(`the session is ${this.state}, not stopped${this.state === "idle" ? " (it's waiting on a request, its stdin or a timer: a breakpoint in what handles it stops it there)" : ""}`);
		}

		const next = this.next(signal);

		await this.session.customRequest(action, { "threadId": this.thread });

		return next;
	}

	public async decide(choice: string, signal: AbortSignal): Promise<DebugOutcome> {
		if (this.state !== "stopped" || this.reason !== "capability") {
			throw new Error("the session isn't stopped at a question");
		}

		const next = this.next(signal);

		await vscode.commands.executeCommand("margin.decide", this.session.id, choice);

		return next;
	}
}

function resolveProgram(program: string | undefined): string {
	const path = program ?? vscode.window.activeTextEditor?.document.uri.path;

	if (path === undefined || path === "") {
		throw new Error("no program: pass one (src/index.ts, say), or open the file in the editor");
	}

	return path.startsWith("/") ? path : `${(vscode.workspace.workspaceFolders?.[0]?.uri.path ?? "/workspace").replace(/\/$/u, "")}/${path}`;
}

function setBreakpoints(program: string, lines: number[]): void {
	const uri = vscode.Uri.file(program);

	vscode.debug.removeBreakpoints(vscode.debug.breakpoints.filter((breakpoint) => breakpoint instanceof vscode.SourceBreakpoint && breakpoint.location.uri.toString() === uri.toString()));
	vscode.debug.addBreakpoints(lines.map((line) => new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(line - 1, 0)))));
}

export function serveDebugControl(context: vscode.ExtensionContext, hub: Hub, log?: ObservedExtension["log"]): void {
	const sessions = new Map<string, Session>();
	const launches = new Map<string, (session: Session) => void>();
	const served = new Map<string, () => void>();
	const ended = new Set<string>();

	const follow = (debugSession: vscode.DebugSession): Session | undefined => {
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

	const start = async (program: string | undefined, breakpoints: number[] | undefined, eventLoop: unknown, signal: AbortSignal): Promise<DebugOutcome> => {
		const path = resolveProgram(program);

		if (!/\.[cm]?[jt]sx?$/u.test(path)) {
			throw new Error(`${path.split("/").pop() ?? path} isn't a program: Run runs a JavaScript or TypeScript file`);
		}

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

		if (!await vscode.debug.startDebugging(undefined, { "type": runDebugger(), "request": "launch", "name": "Run", "program": path, "__launchId": launch, ...eventLoop === undefined ? {} : { "eventLoop": eventLoop } })) {
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

				if (session === undefined) {
					return undefined;
				}

				session.tracked = true;

				return {
					"onDidSendMessage": (message: { "type"?: string; "event"?: string; "body"?: Record<string, unknown> }) => {
						session.sent(message);
					},
					"onWillReceiveMessage": (message: { "type"?: string; "command"?: string }) => {
						session.received(message);
					}
				};
			}
		}),
		vscode.debug.onDidStartDebugSession((debugSession) => {
			if (!ended.has(debugSession.id)) {
				follow(debugSession);

				return;
			}

			const launch = debugSession.configuration["__launchId"];
			const over = new Session(debugSession);

			over.settle("terminated");

			if (typeof launch === "string") {
				launches.get(launch)?.(over);
				launches.delete(launch);
			}
		}),
		vscode.debug.onDidReceiveDebugSessionCustomEvent(({ session, event }) => {
			const followed = sessions.get(session.id);

			if (followed?.tracked === false) {
				followed.sent({ "type": "event", "event": event });
			}
		}),
		vscode.debug.onDidChangeActiveStackItem((item) => {
			const followed = item === undefined ? undefined : sessions.get(item.session.id);

			if (followed?.tracked === false && item !== undefined && "frameId" in item) {
				followed.stoppedOn(item.threadId);
			}
		}),
		vscode.debug.onDidTerminateDebugSession((debugSession) => {
			ended.add(debugSession.id);

			if (ended.size > ENDED_KEPT) {
				ended.delete(ended.values().next().value as string);
			}

			sessions.get(debugSession.id)?.settle("terminated");
			sessions.delete(debugSession.id);
			served.get(debugSession.id)?.();
			served.delete(debugSession.id);
		}),
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
			const { program, breakpoints, eventLoop } = (args ?? {}) as { "program"?: string; "breakpoints"?: number[]; "eventLoop"?: unknown };

			return span("start", { "caller": "agent", "path": program ?? "" }, async () => start(program, breakpoints, eventLoop, signal));
		}) },
		{ "dispose": serve(hub, "debug.explore", async (args) => {
			const path = resolveProgram((args as { "program"?: string } | undefined)?.program);

			return span("explore", { "caller": "agent", "path": path }, async () => {
				const explored = await vscode.commands.executeCommand<{ "error"?: string } | undefined>("tsval.exploreOrderings", vscode.Uri.file(path));

				if (explored === undefined || explored.error !== undefined) {
					throw new Error(explored?.error ?? "Explore Orderings didn't run");
				}

				return explored;
			});
		}) },
		{ "dispose": serve(hub, "margin.state", async (args) => vscode.commands.executeCommand("margin.state", resolveProgram((args as { "file"?: string } | undefined)?.file))) }
	);
}
