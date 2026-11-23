import type { DecideRequest, Events, StdinRequest } from "@brianjenkins94/editor-api";
import type { Replay } from "@brianjenkins94/editor-api/recorded";
import type { WorkspaceRuntime } from "@brianjenkins94/editor-api/runtime";

import type { Span } from "@brianjenkins94/util/logger";
import type { Policy } from "@brianjenkins94/util/silo/policy";
import type { RulePlace } from "@brianjenkins94/editor-api";
import type { CapabilityAsk, Control, LoopStart, RunEnd, Snapshot, StepAction, ToWorker, WorkerEvent } from "./debug-protocol";
import { watchWorker } from "@brianjenkins94/editor-api/failures";
import { logger } from "@brianjenkins94/util/logger";
import { EMPTY_POLICY } from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";
import { askEvent, decideControl } from "./adapter/stops";
import { fileToRun, nothingToRun, runOf } from "./run-file";

interface DapRequest { "seq": number; "type": "request"; "command": string; "arguments"?: Record<string, unknown> }
type Dap = Record<string, unknown>;

type DebugState = "starting" | "running" | "stopped" | "idle" | "terminated";
type DebugAction = StepAction;

class TsvalDebugSession implements vscode.DebugAdapter {
	public readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage>;

	public readonly id: string;
	private readonly sendEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	private state: DebugState = "starting";
	private ended = false;
	private readonly told = new Map<string, string>();
	private ask: CapabilityAsk | undefined;
	private readonly breakpointLines = new Map<string, number[]>();
	private live = false;
	private recorded: Record<string, unknown> | undefined;
	private replay: (Replay & { "source": string }) | undefined;

	private seq = 1;
	private worker: ReturnType<typeof startWorker> | undefined;
	private program = "";
	private args: string[] = [];
	private places: Record<string, RulePlace[]> = {};
	private where: { "cwd"?: string; "env"?: Record<string, string> } = {};
	private eventLoop: LoopStart | undefined;
	private lines: number[] = [];
	private snapshot: Snapshot | undefined;

	private readonly sharedControl = typeof SharedArrayBuffer === "undefined" ? undefined : new Int32Array(new SharedArrayBuffer(4));
	private lastStopAtomic = false;

	private readonly log = logger({ "source": "debug-adapter" });
	private actionSpan: Span | undefined;

	private source = "";
	private policy: Policy = EMPTY_POLICY;
	private sourceReady = false;
	private configDone = false;
	private started = false;
	private noDebug = false;
	private valueWaiter: ((answer: Extract<WorkerEvent, { "type": "valueSet" }>) => void) | undefined;

	private readonly runtime: WorkspaceRuntime;

	public constructor(session: vscode.DebugSession, runtime: WorkspaceRuntime) {
		this.onDidSendMessage = this.sendEmitter.event;
		this.id = session.id;
		this.runtime = runtime;
	}

	public handleMessage(message: vscode.DebugProtocolMessage): void {
		const request = message as DapRequest;

		if (request.type !== "request") {
			return;
		}

		const args = request.arguments ?? {};

		switch (request.command) {
			case "initialize":
				this.respond(request, { "supportsConfigurationDoneRequest": true, "supportsTerminateRequest": true, "supportsStepBack": true, "supportsSetVariable": true });
				this.event("initialized");
				break;

			case "setBreakpoints":
				this.setBreakpointsRequest(request, args);
				break;

			case "setExceptionBreakpoints":
				this.respond(request, { "breakpoints": [] });
				break;

			case "configurationDone":
				this.respond(request);
				this.configDone = true;
				this.maybeStart();
				break;

			case "stdin": {
				const { data, end } = args as unknown as StdinRequest;

				this.control({ "type": "stdin", "data": data ?? "", ...end === true ? { "end": true } : {} });
				this.respond(request);
				break;
			}

			case "launch":
				this.launchRequest(request, args);
				break;

			case "decide":
				this.decideRequest(request, args);
				break;

			default:
				this.inspectionRequest(request, args);
				break;
		}
	}

	public dispose(): void {
		this.closeWorker();
		this.sendEmitter.dispose();
	}

	private setBreakpointsRequest(request: DapRequest, args: Record<string, unknown>): void {
		const points = (args["breakpoints"] as { "line": number }[] | undefined) ?? [];
		const path = (args["source"] as { "path"?: string } | undefined)?.path ?? "";

		this.breakpointLines.set(path, points.map((point) => point.line));
		this.lines = this.noDebug || this.live ? [] : this.breakpointLines.get(this.program) ?? [];

		if (path === this.program) {
			this.control({ "type": "setBreakpoints", "lines": this.lines });
		} else if (!this.noDebug && !this.live) {
			this.control({ "type": "setBreakpoints", "lines": this.breakpointLines.get(path) ?? [], "file": path });
		}

		this.respond(request, { "breakpoints": points.map((point) => ({ "verified": true, "line": point.line })) });
	}

	private launchRequest(request: DapRequest, args: Record<string, unknown>): void {
		this.program = (args["program"] as string | undefined) ?? "";
		this.args = Array.isArray(args["args"]) ? (args["args"] as unknown[]).map(String) : [];
		this.where = { ...typeof args["cwd"] === "string" ? { "cwd": args["cwd"] } : {}, ...typeof args["env"] === "object" && args["env"] !== null ? { "env": args["env"] as Record<string, string> } : {} };
		this.eventLoop = loopStartOf(args["eventLoop"]);
		this.noDebug = args["noDebug"] === true;
		this.policy = typeof args["__policy"] === "object" && args["__policy"] !== null ? args["__policy"] as Policy : EMPTY_POLICY;
		this.places = typeof args["__places"] === "object" && args["__places"] !== null ? args["__places"] as Record<string, RulePlace[]> : {};
		this.live = args["__live"] === true;
		this.recorded = typeof args["__recorded"] === "object" && args["__recorded"] !== null ? args["__recorded"] as Record<string, unknown> : undefined;
		this.replay = typeof args["replay"] === "object" && args["replay"] !== null ? args["replay"] as Replay & { "source": string } : undefined;
		this.lines = this.noDebug || this.live ? [] : this.breakpointLines.get(this.program) ?? [];
		this.respond(request);
		void this.loadSource();
	}

	private decideRequest(request: DapRequest, args: Record<string, unknown>): void {
		if (this.state !== "stopped" || this.ask === undefined) {
			this.fail(request, "not stopped at a capability call");

			return;
		}

		const answer = args as unknown as DecideRequest;

		if (answer.policy !== undefined) {
			this.policy = answer.policy;
		}

		this.control(decideControl(answer));
		this.respond(request);
		this.goOn("continue");
	}

	private inspectionRequest(request: DapRequest, args: Record<string, unknown>): void {
		switch (request.command) {
			case "threads":
				this.respond(request, { "threads": [{ "id": 1, "name": "tsval" }] });
				break;

			case "stackTrace":
				this.respond(request, {
					"stackFrames": (this.snapshot?.frames ?? []).map(({ file, ...frame }) => ({ ...frame, "source": { "path": file ?? this.program } })),
					"totalFrames": this.snapshot?.frames.length ?? 0
				});
				break;

			case "scopes":
				this.respond(request, { "scopes": this.snapshot?.scopes[args["frameId"] as number] ?? [] });
				break;

			case "evaluate":
				this.evaluateRequest(request, args);
				break;

			case "pace":
				this.pace(args["pace"] === "fast" ? "fast" : "real");
				this.respond(request);
				break;

			case "setVariable":
				void this.setValue((args["name"] as string | undefined) ?? "", (args["value"] as string | undefined) ?? "").then((value) => {
					this.respond(request, { "value": value });
				}, (error: unknown) => {
					this.fail(request, messageOf(error));
				});
				break;

			case "variables":
				this.respond(request, { "variables": this.snapshot?.variables[args["variablesReference"] as number] ?? [] });
				break;

			default:
				this.executionRequest(request);
				break;
		}
	}

	private evaluateRequest(request: DapRequest, args: Record<string, unknown>): void {
		if (args["context"] === "repl") {
			this.stdin(((args["expression"] as string | undefined) ?? "") + "\n");
			this.respond(request, { "result": "", "variablesReference": 0 });
		} else {
			this.fail(request, "tsval evaluates nothing here: the Debug Console is the program's stdin");
		}
	}

	private executionRequest(request: DapRequest): void {
		switch (request.command) {
			case "continue":
				this.resume("continue");
				this.respond(request, { "allThreadsContinued": true });
				break;

			case "next":
				this.resume("next");
				this.respond(request);
				break;

			case "stepIn":
				this.resume("stepIn");
				this.respond(request);
				break;

			case "stepOut":
				this.resume("stepOut");
				this.respond(request);
				break;

			case "stepBack":
				this.resume("stepBack");
				this.respond(request);
				break;

			case "reverseContinue":
				this.resume("reverseContinue");
				this.respond(request, { "allThreadsContinued": true });
				break;

			case "disconnect":
			case "terminate":
				this.terminateRequest(request);
				break;

			default:
				this.respond(request);
				break;
		}
	}

	private terminateRequest(request: DapRequest): void {
		if (this.live && !this.ended) {
			this.ended = true;
			this.endAction();
			this.closeWorker();
			this.respond(request);
			this.event("terminated");
			this.settle("terminated");

			return;
		}

		this.endAction();
		this.closeWorker();
		const frame = this.state === "stopped" ? this.snapshot?.frames[0] : undefined;

		this.tellEnded(frame === undefined ? undefined : { "kind": "stopped", "line": frame.line - 1, ...frame.at === undefined ? {} : { "at": frame.at } }, frame?.file);
		this.respond(request);
		this.event("terminated");
		this.settle("terminated");
	}

	private goOn(action: DebugAction): void {
		this.event("continued", { "threadId": 1, "allThreadsContinued": true });
		this.resume(action);
	}

	private pace(pace: "real" | "fast"): void {
		this.control({ "type": "pace", "pace": pace });
	}

	private stdin(data: string): void {
		this.control({ "type": "stdin", "data": data });
	}

	private async setValue(name: string, value: string): Promise<string> {
		if (this.state !== "stopped") {
			throw new Error("not stopped");
		}

		if (this.lastStopAtomic) {
			throw new Error("paused inside a handler: values can't be set there yet");
		}

		const answer = await new Promise<Extract<WorkerEvent, { "type": "valueSet" }>>((resolve) => {
			this.valueWaiter = resolve;
			this.control({ "type": "setValue", "name": name, "value": value });
		});

		if (!answer.ok) {
			throw new Error(answer.error ?? "couldn't set it");
		}

		if (answer.snapshot !== undefined) {
			this.snapshot = answer.snapshot;
		}

		return answer.value ?? value;
	}

	private settle(state: DebugState): void {
		this.state = state;
	}

	private send(message: Dap): void {
		this.sendEmitter.fire({ ...message, "seq": this.seq });
		this.seq += 1;
	}

	private respond(request: DapRequest, body?: Dap): void {
		this.send({ "type": "response", "request_seq": request.seq, "success": true, "command": request.command, "body": body ?? {} });
	}

	private fail(request: DapRequest, message: string): void {
		this.send({ "type": "response", "request_seq": request.seq, "success": false, "command": request.command, "message": message, "body": {} });
	}

	private event(event: string, body?: Dap): void {
		this.send({ "type": "event", "event": event, "body": body ?? {} });
	}

	private tell<Name extends keyof Events>(name: Name, body: Events[Name]): void {
		this.event(name, body as unknown as Dap);
	}

	private startAction(kind: string): { "traceId": string; "parentSpanId": string } {
		this.actionSpan?.end();
		this.actionSpan = this.log.span("editor.extensions.tsval.debug-adapter." + kind);

		return { "traceId": this.actionSpan.traceId, "parentSpanId": this.actionSpan.id };
	}

	private endAction(): void {
		this.actionSpan?.end();
		this.actionSpan = undefined;
	}

	private async loadSource(): Promise<void> {
		try {
			this.source = this.replay?.source ?? (await vscode.workspace.openTextDocument(vscode.Uri.file(this.program))).getText();
			this.sourceReady = true;
			this.maybeStart();
		} catch (error) {
			this.event("output", { "category": "stderr", "output": `Failed to read ${this.program}: ${String(error)}\n` });
			this.event("terminated");
		}
	}

	private maybeStart(): void {
		if (this.started || !this.sourceReady || !this.configDone) {
			return;
		}

		this.started = true;
		this.worker = startWorker(this.runtime, this.id, (event) => {
			this.onWorker(event);
		}, (message, loaded) => {
			this.event("output", { "category": "stderr", "output": `[debug-worker] ${loaded ? "uncaught error" : "couldn't load"}: ${message}\n` });

			if (!loaded && !this.ended) {
				this.ended = true;
				this.endAction();
				this.event("exited", { "exitCode": 1 });
				this.event("terminated");
				this.closeWorker();
				this.settle("terminated");
			}
		});

		const trace = this.startAction("launch");

		this.control({ "type": "launch", "source": this.source, "fileName": this.program, "lines": this.lines, "control": this.sharedControl?.buffer, "policy": this.policy, "places": this.places, ...this.live ? { "live": true, "recorded": this.recorded } : {}, "args": this.args, "program": vscode.workspace.asRelativePath(vscode.Uri.file(this.program), false), "files": this.otherFileLines(), ...this.where, ...this.worker.buffer === undefined ? {} : { "workspace": this.worker.buffer }, ...this.eventLoop === undefined ? {} : { "eventLoop": this.eventLoop }, ...this.replay === undefined ? {} : { "replay": { "fn": this.replay.fn, "free": this.replay.free, "self": this.replay.self, "args": this.replay.args, "calls": this.replay.calls } } }, trace);
	}

	private control(message: Control, trace?: { "traceId": string; "parentSpanId": string }): void {
		this.worker?.send(message, trace);
	}

	private otherFileLines(): Record<string, number[]> {
		return this.noDebug ? {} : Object.fromEntries([...this.breakpointLines].filter(([path, lines]) => path !== this.program && lines.length > 0));
	}

	private closeWorker(): void {
		this.worker?.close();
		this.worker = undefined;
	}

	private tellEnded(end: RunEnd | undefined, endFile = this.program): void {
		if (this.ended) {
			return;
		}

		this.ended = true;

		const sources = new Map([[this.program, this.source], ...this.told]);

		if (this.ask?.file !== undefined && !sources.has(this.ask.file)) {
			sources.set(this.ask.file, this.ask.source ?? "");
		}

		for (const [file, source] of sources) {
			this.tell("ended", { "file": file, "source": source, ...end === undefined || file !== endFile ? {} : { "end": end } });
		}

		if (end !== undefined && !sources.has(endFile)) {
			this.tell("ended", { "file": endFile, "end": end });
		}
	}

	private resume(kind: StepAction): void {
		const trace = this.startAction(kind);

		this.ask = undefined;

		this.state = "running";

		if (this.lastStopAtomic && this.sharedControl !== undefined) {
			Atomics.store(this.sharedControl, 0, 1);
			Atomics.notify(this.sharedControl, 0);
		} else {
			this.control({ "type": kind }, trace);
		}
	}

	private onWorker(message: WorkerEvent): void {
		switch (message.type) {
			case "stopped":
				this.onStopped(message);
				break;

			case "values":
				this.onValues(message);
				break;

			case "effects":
				this.tell("effects", { "effects": message.effects });
				break;

			case "coverage":
				this.tell("coverage", message.coverage);
				break;

			case "tests":
				this.tell("tests", { "file": this.program, "tests": message.tests, ...message.packages === undefined ? {} : { "packages": message.packages } });
				break;

			case "terminated":
				this.onTerminated(message);
				break;

			case "output":
				if (!this.live) {
					this.event("output", { "category": message.stream ?? "stdout", "output": message.text + "\n" });
				}

				break;

			case "recorded":
				this.tell("recorded", { "capability": message.capability, "resource": message.resource, "value": message.value, ...message.request === undefined ? {} : { "request": message.request } });
				break;

			case "valueSet": {
				const waiter = this.valueWaiter;

				this.valueWaiter = undefined;
				waiter?.(message);
				break;
			}

			case "listening":
				this.tell("listening", { "port": message.port });
				this.event("output", { "category": "console", "output": `listening on ${message.port}\n` });
				break;

			case "busy":
				this.tell("busy", {});
				break;

			case "serving":
				this.endAction();
				this.settle("idle");
				this.tell("idle", {});
				break;

			default:
				break;
		}
	}

	private onStopped(message: Extract<WorkerEvent, { "type": "stopped" }>): void {
		this.snapshot = message.snapshot;
		this.lastStopAtomic = message.atomic === true;
		this.endAction();
		this.ask = message.ask;

		if (message.ask !== undefined) {
			this.tell("ask", askEvent(message.ask, this.program, this.source));
		}

		this.event("stopped", { "reason": message.reason, "threadId": 1, "allThreadsStopped": true });
		this.settle("stopped");
	}

	private onValues(message: Extract<WorkerEvent, { "type": "values" }>): void {
		const file = message.file ?? this.program;
		const source = message.file === undefined ? this.source : message.source ?? this.told.get(file) ?? "";

		this.tell("values", { "file": file, ...this.told.has(file) ? {} : { "source": source }, ...message.batch });
		this.told.set(file, source);
	}

	private onTerminated(message: Extract<WorkerEvent, { "type": "terminated" }>): void {
		this.endAction();

		if (message.quiet === true) {
			this.ended = true;
		}

		this.tellEnded(message.crash === undefined ? undefined : { "kind": message.crash.stopped === true ? "stopped" : "crashed", "line": message.crash.line, "at": message.crash.at, "message": message.crash.message }, message.crash?.file);
		this.event("exited", { "exitCode": message.exitCode ?? 0 });
		this.event("terminated");
		this.closeWorker();
		this.settle("terminated");
	}

}

const LINK_GRACE_MS = 1000;

function messageOf(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	const thrown = error as string | number | boolean | null | undefined;

	return String(thrown);
}

function loopStartOf(value: unknown): LoopStart | undefined {
	const { now, seed, schedule } = (typeof value === "object" && value !== null ? value : {}) as Partial<LoopStart>;

	return typeof now === "number" && typeof seed === "number" ? { "now": now, "seed": seed, ...Array.isArray(schedule) ? { "schedule": schedule.map(Number) } : {} } : undefined;
}

export function startWorker(runtime: WorkspaceRuntime, session: string | undefined, onEvent: (event: WorkerEvent) => void, onError: (message: string, loaded: boolean) => void): { "buffer": SharedArrayBuffer | undefined; "send": (control: Control, trace?: { "traceId": string; "parentSpanId": string }) => void; "close": () => void } {
	const url = new URL("./lsp/debug-worker.js", location.href);

	url.searchParams.set("v", String(Date.now()));

	const link = runtime.connect("debug-worker", session);
	const worker = new Worker(url, { "type": "module" });
	const post = (message: ToWorker, transfer: Transferable[] = []): void => {
		worker.postMessage(message, transfer);
	};

	worker.onmessage = (event: MessageEvent<WorkerEvent>) => {
		onEvent(event.data);
	};

	watchWorker(worker, "debug-worker", onError);

	post({ "kind": "runtime", "port": link.port }, [link.port]);

	return {
		"buffer": runtime.buffer,
		"send": (control, trace) => {
			post({ "kind": "control", "control": control, ...trace === undefined ? {} : { "trace": trace } });
		},
		"close": () => {
			worker.terminate();
			setTimeout(() => {
				link.dispose();
			}, LINK_GRACE_MS);
		}
	};
}

export function registerTsvalDebug(context: vscode.ExtensionContext, runtime: WorkspaceRuntime): void {
	context.subscriptions.push(
		...(["fast", "real"] as const).map((pace) => vscode.commands.registerCommand(pace === "fast" ? "tsval.skipWaits" : "tsval.waitRealTime", async () => {
			const session = vscode.debug.activeDebugSession;

			if (session?.type === "tsval") {
				await session.customRequest("pace", { "pace": pace });
				await vscode.commands.executeCommand("setContext", "tsval.skipWaits", pace === "fast");
			}
		})),
		vscode.debug.onDidStartDebugSession(() => { void vscode.commands.executeCommand("setContext", "tsval.skipWaits", false); }),
		vscode.debug.registerDebugConfigurationProvider("tsval", {
			"resolveDebugConfiguration": (_folder, config) => {
				if (config.type === undefined) {
					const file = fileToRun();

					if (file === undefined) {
						nothingToRun();

						return undefined;
					}

					return runOf(file);
				}

				return config;
			}
		}),
		vscode.debug.registerDebugAdapterDescriptorFactory("tsval", {
			"createDebugAdapterDescriptor": (session) => new vscode.DebugAdapterInlineImplementation(new TsvalDebugSession(session, runtime))
		})
	);
}
