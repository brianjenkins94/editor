/**
 * tsval Debug Adapter — a `vscode.DebugAdapterInlineImplementation` that runs in the extension host and bridges the
 * DAP (spoken by VS Code's debug UI) to the tsval debug worker (debug-worker.ts), which actually interprets the
 * program with tsval's stepping VM.
 *
 * Division of labor: the worker owns execution and produces a full snapshot on every stop (frames + scopes +
 * variables); this adapter is a thin translator — it maps DAP requests to worker control messages (debug-protocol.ts,
 * over the bridge hub) and answers stackTrace/scopes/variables straight out of the latest snapshot. It also serves the
 * session over hub RPC (debug-control.ts), so debug-mcp can drive it too. Inline is the only viable shape in-browser
 * (a DebugAdapterServer needs a socket).
 */
import type { DecideRequest, Events, StdinRequest } from "@brianjenkins94/editor-api";
import type { WorkspaceRuntime } from "@brianjenkins94/editor-api/runtime";

import type { Span } from "@brianjenkins94/util/logger";
import type { Policy } from "@brianjenkins94/util/silo/policy";
import type { CapabilityAsk, Control, LoopStart, RunEnd, Snapshot, StepAction, ToWorker, WorkerEvent } from "./debug-protocol";
import { watchWorker } from "@brianjenkins94/editor-api/failures";
import { logger } from "@brianjenkins94/util/logger";
import { EMPTY_POLICY } from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";
import { askEvent, decideControl } from "./adapter/stops";

interface DapRequest { "seq": number; "type": "request"; "command": string; "arguments"?: Record<string, unknown> }
type Dap = Record<string, unknown>;

/** Where a session is: `starting` until its first stop; `idle`, waiting — on a request, its stdin or a timer. */
type DebugState = "starting" | "running" | "stopped" | "idle" | "terminated";
type DebugAction = StepAction;

class TsvalDebugSession implements vscode.DebugAdapter {
	public readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage>;

	public readonly id: string;
	private readonly sendEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	// Where the session is (an agent follows it by its DAP messages: debug-control.ts).
	private state: DebugState = "starting";
	/** Whether the end was told (`values.ended`): a stop after the program's own end doesn't tell it again. */
	private ended = false;
	/** The program's files the Margin has values of, each with the text that ran (sent with its first values). */
	private readonly told = new Map<string, string>();
	/** What the capability stop it's at asks (RUNNING.md, *Capability stops*), until the run resumes. */
	private ask: CapabilityAsk | undefined;
	/** Breakpoint lines by source path — VS Code sends them per file, and tsval runs one program. */
	private readonly breakpointLines = new Map<string, number[]>();

	private seq = 1;
	// The debug worker: the run, interpreted — the adapter's own, by messages (debug-protocol.ts' ToWorker / WorkerEvent).
	private worker: ReturnType<typeof startWorker> | undefined;
	private program = "";
	/** The program's arguments (the launch config's `args`): its `process.argv` after the node and the file. */
	private args: string[] = [];
	/** Where it was started and with what environment — a terminal's (`cwd`, `env`); none, the workspace and nothing. */
	private where: { "cwd"?: string; "env"?: Record<string, string> } = {};
	/** Where the event loop starts — given by a launch (its clock, its seed, the choices to make), else fresh. */
	private eventLoop: LoopStart | undefined;
	private lines: number[] = [];
	private snapshot: Snapshot | undefined;

	// Shared control word for resuming a SYNCHRONOUS in-handler pause (M3b). When a breakpoint is hit inside a
	// host-invoked guest call the worker blocks on Atomics.wait (it can't receive messages), so we resume it by
	// storing 1 + Atomics.notify rather than postMessage. Needs cross-origin isolation; off-COI SharedArrayBuffer
	// is undefined, so guard here — otherwise this initializer THROWS and the whole debug session dies at
	// construction with no message. Undefined = degrade: the worker never gets the buffer, so it can't sync-pause
	// (top-level message-driven stepping still works), matching how every other SAB layer degrades off-COI.
	private readonly sharedControl = typeof SharedArrayBuffer === "undefined" ? undefined : new Int32Array(new SharedArrayBuffer(4));
	private lastStopAtomic = false;

	// Each DAP action (launch/continue/next/…) opens a span here; its traceContext rides the control message so
	// the worker's step span CONTINUES this trace (one cross-context trace per action). It ends on the resulting
	// stop/terminate, so the span's duration is the action's true round-trip. Federates via the ext host's relay.
	private readonly log = logger({ "source": "debug-adapter" });
	private actionSpan: Span | undefined;

	// The program runs only once BOTH the source is loaded (launch) and configuration is done — so breakpoints
	// set between the `initialized` event and `configurationDone` are registered before the first step.
	private source = "";
	// The capability policy the run decides its calls by — the editor's, given at launch (`__policy`, the run contract)
	// and with each answer that changes it (`decide`) — handed to the worker so it pre-arms capability breakpoints (a
	// gated call hard-stops at its line). Empty when there's none — then every undecided dangerous call breaks
	// (firewall default).
	private policy: Policy = EMPTY_POLICY;
	private sourceReady = false;
	private configDone = false;
	private started = false;
	/** Run Without Debugging: breakpoints don't stop it. Capability breakpoints still do — they're
	 *  the policy gate, not a debugging aid. */
	private noDebug = false;
	/** A `setValue` waiting on the worker's answer. */
	private valueWaiter: ((answer: Extract<WorkerEvent, { "type": "valueSet" }>) => void) | undefined;

	/** The workspace runtime its worker connects to (the bridge's export, as any debugger's). */
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
				// supportsStepBack lights up VS Code's reverse toolbar (Step Back + Reverse) — tsval time travel.
				// supportsSetVariable: the Variables view's Set Value, as the notes margin's (setValue).
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

			// Input for the program's process.stdin — a terminal's run's typing (the run contract's `stdin`, debug-events.ts).
			case "stdin": {
				const { data, end } = args as unknown as StdinRequest;

				this.control({ "type": "stdin", "data": data ?? "", ...end === true ? { "end": true } : {} });
				this.respond(request);
				break;
			}

			case "launch":
				this.launchRequest(request, args);
				break;

			// At a capability stop, the editor's answer (the run contract's `decide`, capability-stops.ts): how the call goes,
			// and the policy from now on when the answer changed it. Then the run goes on.
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
		// Per file: the program's entry's, or another file's — one of the program's own when it loads it (packages/tsval/README.md, *Modules*).
		const points = (args["breakpoints"] as { "line": number }[] | undefined) ?? [];
		const path = (args["source"] as { "path"?: string } | undefined)?.path ?? "";

		this.breakpointLines.set(path, points.map((point) => point.line));
		this.lines = this.noDebug ? [] : this.breakpointLines.get(this.program) ?? [];

		if (path === this.program) {
			this.control({ "type": "setBreakpoints", "lines": this.lines });
		} else if (!this.noDebug) {
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
		this.lines = this.noDebug ? [] : this.breakpointLines.get(this.program) ?? [];
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

	/** What the snapshot answers (threads, frames, scopes, variables), the Debug Console, and the session's settings. */
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

			// The Debug Console is the program's stdin: what's typed there is a line of its input.
			case "evaluate":
				this.evaluateRequest(request, args);
				break;

			// Skip Waits / Wait in Real Time (tsval.skipWaits): what a timer's wait costs from here on.
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

	/** Running it: continuing, stepping (forward and back), and ending it. */
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
		// Stopped early: hard-stop — terminate() kills the worker even while it's blocked in Atomics.wait (an in-handler
		// pause), which a postMessage could not reach.
		this.endAction();
		this.closeWorker();
		// Its end told, as when it runs to its end — and, stopped while paused, where it was.
		const frame = this.state === "stopped" ? this.snapshot?.frames[0] : undefined;

		this.tellEnded(frame === undefined ? undefined : { "kind": "stopped", "line": frame.line - 1, ...frame.at === undefined ? {} : { "at": frame.at } }, frame?.file);
		this.respond(request);
		this.event("terminated");
		this.settle("terminated");
	}

	/** Resume with `action`, from somewhere other than VS Code's UI (an agent, an answer at a capability stop). */
	private goOn(action: DebugAction): void {
		// The action didn't come from VS Code's UI, so tell it (and the toolbar mirror) the session is running again.
		this.event("continued", { "threadId": 1, "allThreadsContinued": true });
		this.resume(action);
	}

	/** At a stop, set `name` (a variable in scope there) to `value` (a literal): the run goes on with it, and the margin
	 *  shows it beside the line. Resolves with the value as the Variables view shows it; rejects when it can't be set. */
	/** What a timer's wait costs from here on (Skip Waits): its real delay, or none. */
	private pace(pace: "real" | "fast"): void {
		this.control({ "type": "pace", "pace": pace });
	}

	/** Input for the program's process.stdin (the Debug Console's lines). */
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

	/** Answer `request` with an error VS Code shows. */
	private fail(request: DapRequest, message: string): void {
		this.send({ "type": "response", "request_seq": request.seq, "success": false, "command": request.command, "message": message, "body": {} });
	}

	private event(event: string, body?: Dap): void {
		this.send({ "type": "event", "event": event, "body": body ?? {} });
	}

	/** One of the run contract's events (@brianjenkins94/editor-api): what the editor reads from a run, whichever
	 *  debugger's — debug-events.ts turns it into the margin's values, the run's evidence and its effects. */
	private tell<Name extends keyof Events>(name: Name, body: Events[Name]): void {
		this.event(name, body as unknown as Dap);
	}

	/** Open the span for a DAP action and return its traceContext to hand the worker (so its step continues this
	 *  trace). Ends any still-open action span first — an action always resolves to a stop before the next one. */
	private startAction(kind: string): { "traceId": string; "parentSpanId": string } {
		this.actionSpan?.end();
		this.actionSpan = this.log.span("editor.extensions.tsval.debug-adapter." + kind);

		return { "traceId": this.actionSpan.traceId, "parentSpanId": this.actionSpan.id };
	}

	/** Close the current action span (the worker reported a stop or terminated — the round-trip is done). */
	private endAction(): void {
		this.actionSpan?.end();
		this.actionSpan = undefined;
	}

	private async loadSource(): Promise<void> {
		try {
			this.source = (await vscode.workspace.openTextDocument(vscode.Uri.file(this.program))).getText();
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
		// Cache-bust so a rebuilt worker is picked up (the Worker constructor may reuse the browser's module
		// cache for an unchanged URL even after a rebuild); harmless in production.
		this.worker = startWorker(this.runtime, this.id, (event) => {
			this.onWorker(event);
		}, (message, loaded) => {
			this.event("output", { "category": "stderr", "output": `[debug-worker] ${loaded ? "uncaught error" : "couldn't load"}: ${message}\n` });

			// One that never loaded never answers: the session ends now, saying why, not when whoever waits on it gives up.
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

		this.control({ "type": "launch", "source": this.source, "fileName": this.program, "lines": this.lines, "control": this.sharedControl?.buffer, "policy": this.policy, "args": this.args, "program": vscode.workspace.asRelativePath(vscode.Uri.file(this.program), false), "files": this.otherFileLines(), ...this.where, ...this.worker.buffer === undefined ? {} : { "workspace": this.worker.buffer }, ...this.eventLoop === undefined ? {} : { "eventLoop": this.eventLoop } }, trace);
	}

	/** A control message for this session's worker; `trace` continues an adapter action's trace in the work it starts. */
	private control(message: Control, trace?: { "traceId": string; "parentSpanId": string }): void {
		this.worker?.send(message, trace);
	}

	/** The user's breakpoints in files other than the program's entry — in a file the program loads, they stop there. */
	private otherFileLines(): Record<string, number[]> {
		return this.noDebug ? {} : Object.fromEntries([...this.breakpointLines].filter(([path, lines]) => path !== this.program && lines.length > 0));
	}

	private closeWorker(): void {
		this.worker?.close();
		this.worker = undefined;
	}

	/** The session's end, once (the run contract's `ended`): how the run ended short, if it did, on its line, in the file
	 *  that's in (`endFile`, the entry by default). */
	private tellEnded(end: RunEnd | undefined, endFile = this.program): void {
		if (this.ended) {
			return;
		}

		this.ended = true;

		const sources = new Map([[this.program, this.source], ...this.told]);

		// A question asked in another of the program's files.
		if (this.ask?.file !== undefined && !sources.has(this.ask.file)) {
			sources.set(this.ask.file, this.ask.source ?? "");
		}

		for (const [file, source] of sources) {
			this.tell("ended", { "file": file, "source": source, ...end === undefined || file !== endFile ? {} : { "end": end } });
		}

		// Ended short in another of the program's files.
		if (end !== undefined && !sources.has(endFile)) {
			this.tell("ended", { "file": endFile, "end": end });
		}
	}

	/** Resume the worker. An in-handler (atomic) stop is unblocked via the control word + notify; a top-level
	 *  stop is driven by a control message the worker's loop is awaiting. */
	private resume(kind: StepAction): void {
		const trace = this.startAction(kind);

		// Resumed, however (an answer, VS Code's toolbar), the question's been answered (capability-stops.ts takes it off
		// the margin).
		this.ask = undefined;

		this.state = "running";

		if (this.lastStopAtomic && this.sharedControl !== undefined) {
			// In-handler pause: the worker is blocked in Atomics.wait mid-step, so it can't receive a message —
			// it resumes its EXISTING step span (already parented to the action that first hit the breakpoint).
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

			// What the run did to the world so far (each telling has it all), for its envelope in the run ledger.
			case "effects":
				this.tell("effects", { "effects": message.effects });
				break;

			// What the run ran of the program's files, as it ends: the gutter's marks (the Margin's coverage).
			case "coverage":
				this.tell("coverage", message.coverage);
				break;

			// A test file's tests, each with what it ran (the run contract's `tests`): kept as traces of them.
			case "tests":
				this.tell("tests", { "file": this.program, "tests": message.tests });
				break;

			case "terminated":
				this.onTerminated(message);
				break;

			// (started in a terminal, its stdout and stderr are printed there too: debug-events.ts)
			case "output":
				this.event("output", { "category": message.stream ?? "stdout", "output": message.text + "\n" });
				break;

			case "valueSet": {
				const waiter = this.valueWaiter;

				this.valueWaiter = undefined;
				waiter?.(message);
				break;
			}

			// A server the program started: the run is a service, with its port (the running list, its preview).
			case "listening":
				this.tell("listening", { "port": message.port });
				this.event("output", { "category": "console", "output": `listening on ${message.port}\n` });
				break;

			// Out of work, serving (a server, a stdin reader): idle — a request goes on from here (the run contract's `idle`).
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
		this.endAction(); // the action reached a stop — close its round-trip span
		this.ask = message.ask;

		// A capability stop asks on its line (the run contract's `ask`: the margin shows it — capability-stops.ts) — in
		// the file it's in.
		if (message.ask !== undefined) {
			this.tell("ask", askEvent(message.ask, this.program, this.source));
		}

		this.event("stopped", { "reason": message.reason, "threadId": 1, "allThreadsStopped": true });
		this.settle("stopped");
	}

	/** The run's values, on to the Margin: the file they're of, the text that ran once a file, what's new. */
	private onValues(message: Extract<WorkerEvent, { "type": "values" }>): void {
		const file = message.file ?? this.program;
		const source = message.file === undefined ? this.source : message.source ?? this.told.get(file) ?? "";

		this.tell("values", { "file": file, ...this.told.has(file) ? {} : { "source": source }, ...message.batch });
		this.told.set(file, source);
	}

	private onTerminated(message: Extract<WorkerEvent, { "type": "terminated" }>): void {
		this.endAction();

		this.tellEnded(message.crash === undefined ? undefined : { "kind": "crashed", "line": message.crash.line, "at": message.crash.at, "message": message.crash.message }, message.crash?.file);
		// (DAP's own: the run's end, with its exit code — the editor's run ends with it)
		this.event("exited", { "exitCode": message.exitCode ?? 0 });
		this.event("terminated");
		this.closeWorker();
		this.settle("terminated");
	}

}

/** What a rejection says: an Error's message, anything else stringified as it is. */
function messageOf(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}

	const thrown = error as string | number | boolean | null | undefined;

	return String(thrown);
}

/** How each session's program ended (by session id), for whoever reports its end — a terminal's run waits on it. */
/** A launch config's `eventLoop`, when it's one: its clock, its seed, the choices to make. */
function loopStartOf(value: unknown): LoopStart | undefined {
	const { now, seed, schedule } = (typeof value === "object" && value !== null ? value : {}) as Partial<LoopStart>;

	return typeof now === "number" && typeof seed === "number" ? { "now": now, "seed": seed, ...Array.isArray(schedule) ? { "schedule": schedule.map(Number) } : {} } : undefined;
}

/** A debug worker: started, given its link into the editor's runtime (the workspace runtime — its servers answer the
 *  preview through it, its log and spans are the editor's) — for debug session `session`, when it runs one — then sent
 *  control messages; its events go to `onEvent`, a failure to load or an uncaught error to `onError` (with whether it had
 *  loaded), said as the debug worker's (watchWorker). */
function startWorker(runtime: WorkspaceRuntime, session: string | undefined, onEvent: (event: WorkerEvent) => void, onError: (message: string, loaded: boolean) => void): { "buffer": SharedArrayBuffer | undefined; "send": (control: Control, trace?: { "traceId": string; "parentSpanId": string }) => void; "close": () => void } {
	// Cache-bust so a rebuilt worker is picked up (the Worker constructor may reuse the browser's module cache for an
	// unchanged URL even after a rebuild); harmless in production.
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

	// (posted before it loads: queued, and delivered once its module is evaluated — the runtime link first)
	post({ "kind": "runtime", "port": link.port }, [link.port]);

	return {
		"buffer": runtime.buffer,
		"send": (control, trace) => {
			post({ "kind": "control", "control": control, ...trace === undefined ? {} : { "trace": trace } });
		},
		"close": () => {
			worker.terminate();
			link.dispose();
		}
	};
}

export function registerTsvalDebug(context: vscode.ExtensionContext, runtime: WorkspaceRuntime): void {
	context.subscriptions.push(
		// Skip Waits: a tsval session's timers fire without waiting their real delay (the event loop's order unchanged) —
		// and back. The debug toolbar shows whichever applies.
		...(["fast", "real"] as const).map((pace) => vscode.commands.registerCommand(pace === "fast" ? "tsval.skipWaits" : "tsval.waitRealTime", async () => {
			const session = vscode.debug.activeDebugSession;

			if (session?.type === "tsval") {
				await session.customRequest("pace", { "pace": pace });
				await vscode.commands.executeCommand("setContext", "tsval.skipWaits", pace === "fast");
			}
		})),
		vscode.debug.onDidStartDebugSession(() => { void vscode.commands.executeCommand("setContext", "tsval.skipWaits", false); }),
		// Bare F5, no launch.json: the file open. (What Run means beyond that — an app's file, a rule's process.argv, its
		// run in the running list — is the editor's, for any debugger: the bridge's debug-events.ts.)
		vscode.debug.registerDebugConfigurationProvider("tsval", {
			"resolveDebugConfiguration": (_folder, config) => {
				if (config.type === undefined) {
					// eslint-disable-next-line no-template-curly-in-string -- ${file} is a VS Code launch-config variable, not a JS template literal
					return { "type": "tsval", "request": "launch", "name": "Debug (tsval)", "program": "${file}" };
				}

				return config;
			}
		}),
		vscode.debug.registerDebugAdapterDescriptorFactory("tsval", {
			"createDebugAdapterDescriptor": (session) => new vscode.DebugAdapterInlineImplementation(new TsvalDebugSession(session, runtime))
		})
	);
}
