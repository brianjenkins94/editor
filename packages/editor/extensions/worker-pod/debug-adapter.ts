/**
 * tsval Debug Adapter — a `vscode.DebugAdapterInlineImplementation` that runs in the extension host and bridges the
 * DAP (spoken by VS Code's debug UI) to the tsval debug worker (debug-worker.ts), which actually interprets the
 * program with tsval's stepping VM.
 *
 * Division of labor: the worker owns execution and produces a full snapshot on every stop (frames + scopes +
 * variables); this adapter is a thin translator — it maps DAP requests to worker control messages (debug-protocol.ts,
 * over the pod hub) and answers stackTrace/scopes/variables straight out of the latest snapshot. It also serves the
 * session over hub RPC (debug-control.ts), so debug-mcp can drive it too. Inline is the only viable shape in-browser
 * (a DebugAdapterServer needs a socket).
 */
import type { Span } from "@brianjenkins94/util/logger";
import type { DecideRequest, Events } from "@brianjenkins94/run-contract";
import { createRpcClient, portTransport, serve } from "@brianjenkins94/hub";
import { logger } from "@brianjenkins94/util/logger";
import * as vscode from "vscode";

import { EMPTY_POLICY, given as givenBy, placesOf, type Policy, type Rule } from "@brianjenkins94/util/silo/policy";
import { loadEffectivePolicy } from "../capabilities/silo-store";
import type { ControllableSession, DebugAction, DebugOutcome, DebugState } from "./debug-control";
import { registerSession, serveDebugControl } from "./debug-control";
import type { Replay } from "./page-evidence";
import type { CapabilityAsk, Control, CoverageReport, Explored, LoopStart, RunEnd, SetHook, Snapshot, StepAction, WorkerEvent } from "./debug-protocol";
import { controlSubject, eventSubject } from "./debug-protocol";
import { appRootOf, runApp } from "./launch";
import { podHub, workspace } from "./pod";

interface DapRequest { "seq": number; "type": "request"; "command": string; "arguments"?: Record<string, unknown> }
type Dap = Record<string, unknown>;

class TsvalDebugSession implements vscode.DebugAdapter, ControllableSession {
	private readonly sendEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	public readonly onDidSendMessage = this.sendEmitter.event;

	public readonly id: string;
	public readonly launchId: string | undefined;
	// Hub control (debug-control.ts): where the session is, what it printed since the last action, and the callers
	// waiting for its next stop. Served until the session ends.
	private state: DebugState = "starting";
	private stopReason: string | undefined;
	/** Whether the end was told (`values.ended`): a stop after the program's own end doesn't tell it again. */
	private ended = false;
	/** The program's files core has values of, each with the text that ran (sent with its first values): the entry, and
	 *  any other of the program's files (MODULES.md). */
	private readonly told = new Map<string, string>();
	/** What the capability stop it's at asks (LIVE-VALUES.md, step 8), until the run resumes. */
	private ask: CapabilityAsk | undefined;
	private output: string[] = [];
	private readonly waiters = new Set<() => void>();
	private readonly unregister: () => void;
	/** Breakpoint lines by source path — VS Code sends them per file, and tsval runs one program. */
	private readonly breakpointLines = new Map<string, number[]>();

	private seq = 1;
	private worker: Worker | undefined;
	// The debug worker links into the pod hub, and the whole protocol rides that link on this session's subjects.
	private podUnlink: (() => void) | undefined;
	private offEvents: (() => void) | undefined;
	private program = "";
	/** The program's arguments (the launch config's `args`): its `process.argv` after the node and the file. */
	private args: string[] = [];
	/** A recorded call to replay (RUNNING.md: stepping a recorded handler) — the text that ran, and what the call read —
	 *  rather than the file as a program. */
	private replay: (Replay & { "source": string }) | undefined;
	/** Where it was started and with what environment — a terminal's (`cwd`, `env`); none, the workspace and nothing. */
	private where: { "cwd"?: string; "env"?: Record<string, string> } = {};
	/** The terminal run it was started as (`__runId` with `__startedBy: "terminal"`): its output goes there, its stdin
	 *  comes from there (RUNNING.md, step 3). */
	private terminalRun: string | undefined;
	private offTerminal: (() => void) | undefined;
	/** Where the event loop starts — given by a launch that runs one ordering again (exploreProgram's), else fresh. */
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
	/** The rules placed in this program's code, found in the text that runs (`placeRules`). */
	private hooks: SetHook[] = [];
	private sourceReady = false;
	private configDone = false;
	private started = false;
	/** Run Without Debugging (or a coverage run): breakpoints don't stop it. Capability breakpoints still do — they're
	 *  the policy gate, not a debugging aid. */
	private noDebug = false;
	/** A live run (LIVE-VALUES.md, *Live runs, as you type*): launched quiet on a typing pause, stopping at nothing. */
	private live = false;
	/** The latest coverage the worker reported, and whether the final one has gone out as the `coverage` event. */
	private coverage: CoverageReport | undefined;
	private coverageSent = false;
	private readonly coverageWaiters = new Set<(report: CoverageReport) => void>();
	/** A `setValue` waiting on the worker's answer. */
	private valueWaiter: ((answer: Extract<WorkerEvent, { "type": "valueSet" }>) => void) | undefined;

	private readonly session: vscode.DebugSession;

	public constructor(session: vscode.DebugSession) {
		this.session = session;
		this.id = session.id;
		this.launchId = session.configuration["__launchId"] as string | undefined;
		this.unregister = registerSession(podHub, this);
	}

	public outcome(): DebugOutcome {
		const frame = this.snapshot?.frames[0];
		const stopped = this.state === "stopped" && frame !== undefined;
		const scope = stopped ? this.snapshot?.scopes[frame.id]?.[0] : undefined;
		const loop = stopped ? this.snapshot?.scopes[frame.id]?.find(({ name }) => name === "Event loop") : undefined;

		return {
			"session": this.id,
			"name": this.session.name,
			"program": this.program,
			"state": this.state,
			...(stopped
				? {
					"reason": this.stopReason,
					"line": frame.line,
					"column": frame.column,
					"function": frame.name,
					...frame.file === undefined ? {} : { "file": frame.file },
					"code": frame.code ?? this.source.split("\n")[frame.line - 1]?.trim(),
					"locals": (scope === undefined ? [] : this.snapshot?.variables[scope.variablesReference] ?? []).map(({ name, value, type }) => ({ "name": name, "value": value, "type": type })),
					...loop === undefined ? {} : { "eventLoop": (this.snapshot?.variables[loop.variablesReference] ?? []).map(({ name, value, type }) => ({ "name": name, "value": value, "type": type })) }
				}
				: {}),
			"output": [...this.output]
		};
	}

	public act(action: DebugAction, signal: AbortSignal): Promise<DebugOutcome> {
		if (this.state !== "stopped") {
			throw new Error(`session is ${this.state}, not stopped` + (this.state === "idle" ? " (it's waiting — on a request, its stdin or a timer: set a breakpoint in a handler and use it)" : ""));
		}

		const next = this.nextSettle(signal);

		this.goOn(action);

		return next;
	}

	/** Resume with `action`, from somewhere other than VS Code's UI (an agent, an answer at a capability stop). */
	private goOn(action: DebugAction): void {
		this.output = [];
		// The action didn't come from VS Code's UI, so tell it (and the toolbar mirror) the session is running again.
		this.event("continued", { "threadId": 1, "allThreadsContinued": true });
		this.resume(action);
	}

	/** Resolve on the next stop, idle or end — or `signal.reason` if the caller gives up first. */
	public next(signal: AbortSignal): Promise<DebugOutcome> {
		return this.nextSettle(signal);
	}

	/** At a stop, set `name` (a variable in scope there) to `value` (a literal): the run goes on with it, and the margin
	 *  shows it beside the line. Resolves with the value as the Variables view shows it; rejects when it can't be set. */
	/** What a timer's wait costs from here on (Skip Waits): its real delay, or none. */
	public pace(pace: "real" | "fast"): void {
		this.control({ "type": "pace", "pace": pace });
	}

	/** Input for the program's process.stdin (the Debug Console's lines). */
	public stdin(data: string): void {
		this.control({ "type": "stdin", "data": data });
	}

	/** A run started in a terminal (RUNNING.md, step 3): what it types is the program's stdin, its end (Ctrl-D) the
	 *  input's end. Its output goes back there too (`output`). */
	private followTerminal(runId: string | undefined): void {
		this.terminalRun = runId;

		if (runId !== undefined) {
			this.offTerminal = podHub.subscribe(`node.stdin.${runId}`, (data) => {
				const { "data": text, end } = (data ?? {}) as { "data"?: string; "end"?: boolean };

				this.control({ "type": "stdin", "data": text ?? "", ...end === true ? { "end": true } : {} });
			});
		}
	}

	public async setValue(name: string, value: string): Promise<string> {
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

	public settled(signal: AbortSignal): Promise<DebugOutcome> {
		return this.state === "starting" || this.state === "running" ? this.nextSettle(signal) : Promise.resolve(this.outcome());
	}

	public async stop(): Promise<DebugOutcome> {
		await vscode.debug.stopDebugging(this.session);

		return this.outcome();
	}

	/** The outcome once the session next stops, goes idle or ends — or `signal.reason` if the caller gives up first. */
	private nextSettle(signal: AbortSignal): Promise<DebugOutcome> {
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

	/** Enter `state` and answer everyone waiting for the next stop; a session that ended stops being served. */
	private settle(state: DebugState): void {
		this.state = state;

		for (const waiter of [...this.waiters]) {
			waiter();
		}

		this.waiters.clear();

		if (state === "terminated") {
			this.unregister();
		}
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

	/** One of the run contract's events (@brianjenkins94/run-contract): what the editor reads from a run, whichever
	 *  debugger's — debug-events.ts turns it into the margin's values, the run's evidence and its effects. */
	private tell<Name extends keyof Events>(name: Name, body: Events[Name]): void {
		this.event(name, body as unknown as Dap);
	}

	/** Open the span for a DAP action and return its traceContext to hand the worker (so its step continues this
	 *  trace). Ends any still-open action span first — an action always resolves to a stop before the next one. */
	private startAction(kind: string): { "traceId": string; "parentSpanId": string } {
		this.actionSpan?.end();
		this.actionSpan = this.log.span("debug." + kind);

		return { "traceId": this.actionSpan.traceId, "parentSpanId": this.actionSpan.id };
	}

	/** Close the current action span (the worker reported a stop or terminated — the round-trip is done). */
	private endAction(): void {
		this.actionSpan?.end();
		this.actionSpan = undefined;
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

			case "setBreakpoints": {
				// Per file: the program's entry's, or another file's — one of the program's own when it loads it (MODULES.md).
				const points = (args["breakpoints"] as { "line": number }[] | undefined) ?? [];
				const path = String((args["source"] as { "path"?: string } | undefined)?.path ?? "");

				this.breakpointLines.set(path, points.map((point) => point.line));
				this.lines = this.noDebug ? [] : this.breakpointLines.get(this.program) ?? [];

				if (path === this.program) {
					this.control({ "type": "setBreakpoints", "lines": this.lines });
				} else if (!this.noDebug) {
					this.control({ "type": "setBreakpoints", "lines": this.breakpointLines.get(path) ?? [], "file": path });
				}

				this.respond(request, { "breakpoints": points.map((point) => ({ "verified": true, "line": point.line })) });
				break;
			}

			case "setExceptionBreakpoints":
				this.respond(request, { "breakpoints": [] });
				break;

			case "configurationDone":
				this.respond(request);
				this.configDone = true;
				this.maybeStart();
				break;

			// The program's statement coverage so far (a CoverageReport); once it has ended, its final coverage.
			case "getCoverage":
				// With the text that ran, so the margin can place it on the code as it is now (coverage.ts).
				void this.currentCoverage(5000).then((report) => { this.respond(request, { ...report, "source": this.source } as unknown as Dap); });
				break;

			case "launch":
				this.program = String(args["program"] ?? "");
				this.args = Array.isArray(args["args"]) ? (args["args"] as unknown[]).map(String) : [];
				this.replay = typeof args["replay"] === "object" && args["replay"] !== null ? args["replay"] as Replay & { "source": string } : undefined;
				this.where = { ...typeof args["cwd"] === "string" ? { "cwd": args["cwd"] } : {}, ...typeof args["env"] === "object" && args["env"] !== null ? { "env": args["env"] as Record<string, string> } : {} };
				this.eventLoop = loopStartOf(args["eventLoop"]);
				this.followTerminal(args["__startedBy"] === "terminal" && typeof args["__runId"] === "string" ? args["__runId"] : undefined);
				this.noDebug = args["noDebug"] === true;
				this.policy = typeof args["__policy"] === "object" && args["__policy"] !== null ? args["__policy"] as Policy : EMPTY_POLICY;
				// A live run (LIVE-VALUES.md): the file run again as typing pauses — it stops at nothing.
				this.live = args["__live"] === true;
				this.lines = this.noDebug || this.live ? [] : this.breakpointLines.get(this.program) ?? [];
				this.respond(request);
				void this.loadSource();
				break;

			// At a capability stop, the editor's answer (the run contract's `decide`, capability-stops.ts): how the call goes,
			// and the policy from now on when the answer changed it. Then the run goes on.
			case "decide": {
				if (this.state !== "stopped" || this.ask === undefined) {
					this.fail(request, "not stopped at a capability call");
					break;
				}

				const { verdict, value, policy } = args as unknown as DecideRequest;

				if (policy !== undefined) {
					this.policy = policy;
				}

				this.control({ "type": "decide", ...policy === undefined ? {} : { "policy": policy }, "deny": verdict === "deny", "skip": verdict === "skip", ...verdict === "give" ? { "give": value ?? null } : {} });
				this.respond(request);
				this.goOn("continue");
				break;
			}

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
				if (args["context"] === "repl") {
					this.stdin(String(args["expression"] ?? "") + "\n");
					this.respond(request, { "result": "", "variablesReference": 0 });
				} else {
					this.fail(request, "tsval evaluates nothing here: the Debug Console is the program's stdin");
				}

				break;

			// Skip Waits / Wait in Real Time (tsval.skipWaits): what a timer's wait costs from here on.
			case "pace":
				this.pace(args["pace"] === "fast" ? "fast" : "real");
				this.respond(request);
				break;

			case "setVariable":
				void this.setValue(String(args["name"] ?? ""), String(args["value"] ?? "")).then((value) => { this.respond(request, { "value": value }); }, (error: unknown) => { this.fail(request, error instanceof Error ? error.message : String(error)); });
				break;

			case "variables":
				this.respond(request, { "variables": this.snapshot?.variables[args["variablesReference"] as number] ?? [] });
				break;

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
				// Stopped by hand, if it hadn't ended: a run of several cases stops here too.
				if (!this.ended) {
					stoppedByHand.add(this.id);
				}

				// A live run stopped by the next edit, or one that ran nothing: it tells nothing — no coverage, no end — and the
				// margin keeps the last run's until the next one finishes.
				if (this.live && (!this.ended || !this.coverageSent)) {
					this.ended = true;
					this.coverageSent = true;
					this.endAction();
					this.closeWorker();
					this.respond(request);
					this.event("terminated");
					this.settle("terminated");
					break;
				}

				// Stopped early: ask for the coverage so far first, briefly — a worker blocked in Atomics.wait (an
				// in-handler pause) can't answer, and then the last report stands. Then hard-stop: terminate() kills
				// the worker even while it's blocked, which a postMessage could not reach.
				void this.currentCoverage(500).then((report) => {
					this.sendFinalCoverage(report);
					this.endAction();
					this.closeWorker();
					// The session's live values go with it, as when it runs to its end — and, stopped while paused, where it was.
					const frame = this.state === "stopped" ? this.snapshot?.frames[0] : undefined;

					this.tellEnded(frame === undefined ? undefined : { "kind": "stopped", "line": frame.line - 1, ...frame.at === undefined ? {} : { "at": frame.at } }, frame?.file);
					this.respond(request);
					this.event("terminated");
					this.settle("terminated");
				});
				break;

			default:
				this.respond(request);
				break;
		}
	}

	private async loadSource(): Promise<void> {
		try {
			// A replay runs the text that ran in the page (its recorded version), whatever the file holds now.
			this.source = this.replay?.source ?? (await vscode.workspace.openTextDocument(vscode.Uri.file(this.program))).getText();
			this.hooks = await this.placeRules();
			this.sourceReady = true;
			this.maybeStart();
		} catch (error) {
			this.event("output", { "category": "stderr", "output": `Failed to read ${this.program}: ${String(error)}\n` });
			this.event("terminated");
		}
	}

	/** Where the rules placed in this program's code are now (RULES.md: *at*, a span reference): each place found again
	 *  in the text that runs — through edits, as an authored annotation is — by the editor's BABLR. In the entry, and in
	 *  any other file a rule is placed in (it hooks there when the program loads that file — MODULES.md), read as the
	 *  run reads it. One that's lost, or only uncertainly found, isn't applied (the Rules view says so). */
	private async placeRules(): Promise<SetHook[]> {
		// A span reference names its file workspace-relative.
		const entry = vscode.workspace.asRelativePath(vscode.Uri.file(this.program), false);
		const root = vscode.workspace.workspaceFolders?.[0]?.uri;
		const byFile = new Map<string, { "rule": Rule; "place": unknown }[]>();

		for (const rule of this.policy.rules) {
			for (const place of placesOf(rule)) {
				const file = (place as { "file"?: unknown } | null)?.file;

				if (typeof file === "string" && (file === entry || root !== undefined)) {
					byFile.set(file, [...byFile.get(file) ?? [], { "rule": rule, "place": place }]);
				}
			}
		}

		const hooks = await Promise.all([...byFile].map(async ([file, placed]) => {
			const absolute = file === entry ? this.program : vscode.Uri.joinPath(root!, file).path;
			const source = file === entry ? this.source : await Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.file(absolute))).then((bytes) => new TextDecoder().decode(bytes), () => undefined);

			if (source === undefined) {
				return [];
			}

			const found = await Promise.resolve(vscode.commands.executeCommand<({ "status"?: string; "candidate"?: { "start"?: number; "file"?: string } } | undefined)[] | undefined>("editor.annotations.resolve", source, file, placed.map(({ place }) => place))).catch(() => undefined);

			return placed.flatMap(({ rule, place }, index): SetHook[] => {
				const resolution = found?.[index];
				const start = resolution?.candidate?.start;

				if (start === undefined || resolution?.status === "orphaned" || resolution?.status === "uncertain" || (resolution?.candidate?.file !== undefined && resolution.candidate.file !== file)) {
					return [];
				}

				return [{ "line": source.slice(0, start).split("\n").length, "place": place, "rule": rule, ...file === entry ? {} : { "file": absolute } }];
			});
		}));

		return hooks.flat();
	}

	private maybeStart(): void {
		if (this.started || !this.sourceReady || !this.configDone) {
			return;
		}

		this.started = true;
		// Cache-bust so a rebuilt worker is picked up (the Worker constructor may reuse the browser's module
		// cache for an unchanged URL even after a rebuild); harmless in production.
		const workerUrl = new URL("./lsp/debug-worker.js", location.href);

		workerUrl.searchParams.set("v", String(Date.now()));
		workerUrl.searchParams.set("session", this.id); // the worker's subjects are this session's
		// Want its events BEFORE linking it: link() sends our interest first, so its first event already reaches us.
		this.offEvents = podHub.subscribe(eventSubject(this.id), (data) => { this.onWorker(data as WorkerEvent); });
		this.worker = new Worker(workerUrl, { "type": "module" });
		this.worker.onerror = (event) => { this.event("output", { "category": "stderr", "output": `[debug-worker] ${event.message}\n` }); };
		this.podUnlink = podHub.link(portTransport(this.worker));

		const trace = this.startAction("launch");

		// A message nobody has subscribed to yet goes nowhere, so launch once the worker's control subscription has
		// reached us (it subscribes as its module loads, which includes the shared typescript chunk).
		void podHub.whenInterested(controlSubject(this.id), 30000).then((ready) => {
			if (!ready) {
				this.endAction();
				this.event("output", { "category": "stderr", "output": "[debug-worker] didn't start within 30s\n" });
				this.closeWorker();
				this.event("terminated");
				this.settle("terminated");

				return;
			}

			this.control({ "type": "launch", "source": this.source, "fileName": this.program, "lines": this.lines, "control": this.sharedControl?.buffer, "policy": this.policy, "args": this.args, "program": vscode.workspace.asRelativePath(vscode.Uri.file(this.program), false), "hooks": this.hooks, "files": this.otherFileLines(), ...this.where, ...this.replay === undefined ? {} : { "replay": { "fn": this.replay.fn, "free": this.replay.free, "self": this.replay.self, "args": this.replay.args, "calls": this.replay.calls } }, ...workspace.buffer === undefined ? {} : { "workspace": workspace.buffer }, ...this.eventLoop === undefined ? {} : { "eventLoop": this.eventLoop }, ...this.live ? { "live": true } : {} }, trace);
		});
	}

	/** A control message for this session's worker; `trace` continues an adapter action's trace in the work it starts. */
	private control(message: Control, trace?: { "traceId": string; "parentSpanId": string }): void {
		if (this.worker !== undefined) {
			podHub.publish(controlSubject(this.id), message, { "traceContext": trace });
		}
	}

	/** The user's breakpoints in files other than the program's entry — in a file the program loads, they stop there. */
	private otherFileLines(): Record<string, number[]> {
		return this.noDebug ? {} : Object.fromEntries([...this.breakpointLines].filter(([path, lines]) => path !== this.program && lines.length > 0));
	}

	/** The worker's coverage now, or — when it's gone or doesn't answer within `timeoutMs` — the last it reported. */
	private currentCoverage(timeoutMs: number): Promise<CoverageReport> {
		const fallback = (): CoverageReport => this.coverage ?? { "file": this.program, "statements": [], "sites": [] };

		if (this.worker === undefined) {
			return Promise.resolve(fallback());
		}

		return new Promise((resolve) => {
			const timer = setTimeout(() => {
				this.coverageWaiters.delete(answer);
				resolve(fallback());
			}, timeoutMs);
			const answer = (report: CoverageReport): void => {
				clearTimeout(timer);
				resolve(report);
			};

			this.coverageWaiters.add(answer);
			this.control({ "type": "coverage" });
		});
	}

	/** Once per session, before `terminated`: the final coverage as a custom `coverage` event — the session is gone
	 *  after, so this is how a coverage run (or anyone else) gets it (vscode.debug.onDidReceiveDebugSessionCustomEvent). */
	private sendFinalCoverage(report: CoverageReport): void {
		if (!this.coverageSent) {
			this.coverageSent = true;
			// (with the source that ran, which the file may no longer be: the run's evidence is of that)
			this.tell("coverage", { ...report, "file": this.program, "source": this.source });
		}
	}

	private closeWorker(): void {
		this.offEvents?.();
		this.offEvents = undefined;
		this.offTerminal?.();
		this.offTerminal = undefined;
		this.podUnlink?.();
		this.podUnlink = undefined;
		this.worker?.terminate();
		this.worker = undefined;
	}

	/** Resume the worker. An in-handler (atomic) stop is unblocked via the control word + notify; a top-level
	 *  stop is driven by a control message the worker's loop is awaiting. */
	/** The session's end, once, for core (live-values.ts, through debug-events.ts): its values go — from every file it had them in — and how the
	 *  run ended short, if it did, is marked on its line, in the file that's in (`endFile`, the entry by default). */
	private tellEnded(end: RunEnd | undefined, endFile = this.program): void {
		if (this.ended) {
			return;
		}

		this.ended = true;

		const sources = new Map([[this.program, this.source], ...this.told]);

		// A question asked in a file it had no values from (its margin's to clear).
		if (this.ask?.file !== undefined && !sources.has(this.ask.file)) {
			sources.set(this.ask.file, this.ask.source ?? "");
		}

		for (const [file, source] of sources) {
			this.tell("ended", { "file": file, "source": source, ...end === undefined || file !== endFile ? {} : { "end": end } });
		}

		// Ended short in a file it had no values from yet.
		if (end !== undefined && !sources.has(endFile)) {
			this.tell("ended", { "file": endFile, "end": end });
		}
	}

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
				this.snapshot = message.snapshot;
				this.lastStopAtomic = message.atomic === true;
				this.endAction(); // the action reached a stop — close its round-trip span
				this.stopReason = message.reason;
				this.ask = message.ask;

				// A capability stop asks on its line (the run contract's `ask`: the margin shows it — capability-stops.ts) — in
				// the file it's in.
				if (message.ask !== undefined) {
					const { file, source, ...ask } = message.ask;
					const text = file === undefined ? this.source : source;

					this.tell("ask", { ...ask, "file": file ?? this.program, ...text === undefined ? {} : { "source": text } });
				}

				this.event("stopped", { "reason": message.reason, "threadId": 1, "allThreadsStopped": true });
				this.settle("stopped");
				break;

			// What the run did to the world so far (each telling has it all), for its envelope in the run ledger.
			case "effects":
				this.tell("effects", { "effects": message.effects });
				break;

			case "coverage":
				this.coverage = message.report;

				for (const waiter of [...this.coverageWaiters]) {
					waiter(message.report);
				}

				this.coverageWaiters.clear();

				if (message.final === true) {
					this.sendFinalCoverage(message.report);
				}

				break;

			case "terminated":
				this.endAction();
				exitCodes.set(this.id, message.exitCode ?? 0);

				// A live run that ran nothing (its text doesn't parse yet): no values, no coverage, no end — the margin keeps
				// the last run's.
				if (message.quiet === true) {
					this.ended = true;
				}

				// (a live run that ran out of budget ends stopped where it got to, not crashed)
				this.tellEnded(message.crash === undefined ? undefined : { "kind": message.crash.stopped === true ? "stopped" : "crashed", "line": message.crash.line, "at": message.crash.at, "message": message.crash.message }, message.crash?.file);
				this.event("terminated");
				this.closeWorker();
				this.settle("terminated");
				break;

			// What a run's allowed call returned, recorded (RULES.md, slice 2): a rule can give it back.
			case "recorded":
				this.tell("recorded", { "capability": message.capability, "resource": message.resource, "value": message.value });
				break;

			// The session's live values (LIVE-VALUES.md), on to core (through debug-events.ts): the file they're of, what's new.
			case "values": {
				// The text that ran, once a file: what core anchors the values' ranges in.
				const file = message.file ?? this.program;
				const source = message.file === undefined ? this.source : message.source ?? this.told.get(file) ?? "";

				this.tell("values", { "file": file, ...this.told.has(file) ? {} : { "source": source }, ...message.batch });
				this.told.set(file, source);
				break;
			}

			case "output":
				this.event("output", { "category": message.stream ?? "stdout", "output": message.text + "\n" });

				// Started in a terminal: printed there, as the Debug Console mirrors it — not the script's completion value
				// (`→ …`), which the Debug Console shows as a REPL would and node doesn't print.
				if (this.terminalRun !== undefined && !message.text.startsWith("→ ")) {
					podHub.publish(`node.out.${this.terminalRun}`, { "stream": message.stream === "stderr" ? "err" : "out", "data": message.text + "\n" });
				}

				if (this.output.length < 200) {
					this.output.push(message.text);
				}

				break;

			case "valueSet": {
				const waiter = this.valueWaiter;

				this.valueWaiter = undefined;
				waiter?.(message);
				break;
			}

			// A server the program started: the run is a service, with its port (the running list, its preview).
			case "listening": {
				const runId = this.session.configuration["__runId"];

				if (typeof runId === "string") {
					podHub.publish(`node.listening.${runId}`, { "port": message.port });
				}

				this.event("output", { "category": "console", "output": `listening on ${message.port}\n` });
				break;
			}

			// Out of work, serving (a server, a stdin reader): idle — a request goes on from here.
			case "serving":
				this.endAction();
				this.settle("idle");
				break;

			default:
				break;
		}
	}

	public dispose(): void {
		this.unregister();
		this.closeWorker();
		this.sendEmitter.dispose();
	}
}

/** How each session's program ended (by session id), for whoever reports its end — a terminal's run waits on it. */
const exitCodes = new Map<string, number>();

/** A finished session's exit code (0 if it never said), forgotten once read. */
export function takeExitCode(sessionId: string): number {
	const code = exitCodes.get(sessionId) ?? 0;

	exitCodes.delete(sessionId);

	return code;
}

/**
 * Register the `tsval` debug type: a config provider that supplies a default launch config (bare F5 / the
 * green Run button, no launch.json), and the descriptor factory that hands back a worker-backed session.
 *
 * Bare F5 runs the file you have open. A task runs under tsval; a service (it listens, ticks, reads input —
 * lifecycle.ts) needs the event loop tsval doesn't have, so it's run as `node <file>` in a task's terminal instead,
 * which runs it on the real runtime.
 */
/** Sessions the user stopped (not run to their end): a run of several cases goes no further. */
const stoppedByHand = new Set<string>();

/** A launch config's `eventLoop`, when it's one: its clock, its seed, the choices to make. */
function loopStartOf(value: unknown): LoopStart | undefined {
	const { now, seed, schedule } = (typeof value === "object" && value !== null ? value : {}) as Partial<LoopStart>;

	return typeof now === "number" && typeof seed === "number" ? { "now": now, "seed": seed, ...Array.isArray(schedule) ? { "schedule": schedule.map(Number) } : {} } : undefined;
}

/**
 * Every ordering of `program`'s events (tsval's explore, in a debug worker of its own): with the stand-ins and the rules
 * a debug run has — the arguments a rule gives its process.argv too — each way its host calls' answers, and its timers,
 * can come; the distinct outcomes, each with a schedule to debug it by (a launch's `eventLoop`).
 */
export async function exploreProgram(program: string, maxRuns = 100): Promise<Explored> {
	const uri = vscode.Uri.file(program);
	const source = vscode.workspace.textDocuments.find((document) => document.uri.toString() === uri.toString())?.getText() ?? new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
	const policy = await loadEffectivePolicy();
	const mocked = givenBy(policy, { "program": vscode.workspace.asRelativePath(uri, false) }, "process.argv")?.values.find((each): each is string[] => Array.isArray(each));
	const id = `explore-${crypto.randomUUID()}`;
	const workerUrl = new URL("./lsp/debug-worker.js", location.href);

	workerUrl.searchParams.set("v", String(Date.now()));
	workerUrl.searchParams.set("session", id);

	let offEvents: (() => void) | undefined;
	const explored = new Promise<Explored>((resolve) => {
		offEvents = podHub.subscribe(eventSubject(id), (data) => {
			const event = data as WorkerEvent;

			if (event.type === "explored") {
				resolve(event.explored);
			}
		});
	});
	const worker = new Worker(workerUrl, { "type": "module" });
	const unlink = podHub.link(portTransport(worker));

	try {
		if (!await podHub.whenInterested(controlSubject(id), 30_000)) {
			throw new Error("the debug worker didn't start within 30s");
		}

		podHub.publish(controlSubject(id), { "type": "explore", "source": source, "fileName": program, "policy": policy, "args": mocked ?? [], "eventLoop": { "now": Date.now(), "seed": Math.floor(Math.random() * 2 ** 32) }, "maxRuns": maxRuns, ...workspace.buffer === undefined ? {} : { "workspace": workspace.buffer } } satisfies Control);

		return await Promise.race([explored, new Promise<never>((_, reject) => { setTimeout(() => { reject(new Error("exploring took over 2 minutes")); }, 120_000); })]);
	} finally {
		offEvents?.();
		unlink();
		worker.terminate();
	}
}

/** One outcome as the Explore Orderings list shows it: what it ends with, how many runs, the events chosen along it. */
function orderingItem(outcome: Explored["outcomes"][number], index: number): vscode.QuickPickItem & { "index": number } {
	const last = outcome.output.at(-1);

	return {
		"index": index,
		"label": outcome.crash === undefined ? `$(output) ${last ?? "(printed nothing)"}` : `$(error) crashed: ${outcome.crash}`,
		"description": `${outcome.output.length} line${outcome.output.length === 1 ? "" : "s"} · ${outcome.runs} run${outcome.runs === 1 ? "" : "s"}`,
		"detail": outcome.path.length === 0 ? "no choice to make" : outcome.path.join("  →  ")
	};
}

export function registerTsvalDebug(context: vscode.ExtensionContext): void {
	const rpc = createRpcClient(podHub);

	context.subscriptions.push(
		// Explore Orderings (tsval's explore): every way the file's async results and timers can come, run; the distinct
		// endings listed — a race is more than one — and the one picked debugged, run exactly that way.
		vscode.commands.registerCommand("tsval.exploreOrderings", async (target?: vscode.Uri) => {
			const uri = target instanceof vscode.Uri ? target : vscode.window.activeTextEditor?.document.uri;

			if (uri === undefined) {
				return;
			}

			const name = uri.path.split("/").pop()!;
			const explored = await vscode.window.withProgress({ "location": vscode.ProgressLocation.Notification, "title": `Exploring the orderings of ${name}…` }, () => exploreProgram(uri.path));
			const runs = `${explored.runs} run${explored.runs === 1 ? "" : "s"}${explored.complete ? "" : ", cut short"}`;

			if (explored.outcomes.length === 1) {
				void vscode.window.showInformationMessage(`No race in ${name}: every ordering ends the same way (${runs}).`);

				return;
			}

			const picked = await vscode.window.showQuickPick(explored.outcomes.map(orderingItem), { "title": `${name}: ${explored.outcomes.length} ways it can end (${runs}) — pick one to debug it`, "matchOnDetail": true });

			if (picked !== undefined) {
				await vscode.debug.startDebugging(undefined, { "type": "tsval", "request": "launch", "name": `debug ${name} (ordering ${picked.index + 1} of ${explored.outcomes.length})`, "program": uri.path, "eventLoop": { ...explored.eventLoop, "schedule": explored.outcomes[picked.index]!.schedule } });
			}
		}),
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
		{ "dispose": serve(podHub, "debug.explore", async (args) => {
			const { program, maxRuns } = (args ?? {}) as { "program"?: string; "maxRuns"?: number };

			if (typeof program !== "string") {
				throw new TypeError("debug.explore: a program to explore");
			}

			return exploreProgram(program, maxRuns);
		}) },
		vscode.debug.registerDebugConfigurationProvider("tsval", {
			"resolveDebugConfiguration": (_folder, config) => {
				if (config.type === undefined) {
					// A service too (a server, a timer, stdin): tsval serves the preview, keeps it alive, and takes the Debug
					// Console as its input — a terminal's `node <file>` is where it runs for real.
					// eslint-disable-next-line no-template-curly-in-string -- ${file} is a VS Code launch-config variable, not a JS template literal
					return { "type": "tsval", "request": "launch", "name": "Debug (tsval)", "program": "${file}" };
				}

				return config;
			},
			// Every session is a run in core's registry, known by one id from start to end: a terminal's `node` brings its
			// own (`__runId`); one VS Code started (F5, debug_start) asks for one here, once `${file}` is the real path.
			// Without core (no answer), it runs all the same, unrecorded.
			"resolveDebugConfigurationWithSubstitutedVariables": async (_folder, given) => {
				const program = typeof given["program"] === "string" ? given["program"] : "";

				// F5 on an app's file (RUNNING.md, step 4): the app runs — its dev server, its preview — not a session here.
				// (Run's own launches decided that already; a terminal's `node` and an ordering's replay are what they say.)
				if (given["__launchId"] === undefined && given["__startedBy"] !== "terminal" && given["__live"] !== true && given["eventLoop"] === undefined && given["replay"] === undefined && program !== "") {
					const app = await appRootOf(program);

					if (app !== undefined) {
						await runApp(app).catch((error: unknown) => { void vscode.window.showErrorMessage(`Couldn't run: ${error instanceof Error ? error.message : String(error)}`); });

						return undefined;
					}
				}
				// No `args`: what a rule gives the file's process.argv (RULES.md; the margin's Mock), if one does — its first
				// value, the rest each a run after it (`__cases`).
				const mocked = Array.isArray(given["args"]) || Array.isArray(given["__cases"]) || given["replay"] !== undefined || program === "" ? undefined : givenBy(await loadEffectivePolicy(), { "program": vscode.workspace.asRelativePath(vscode.Uri.file(program), false) }, "process.argv");
				const cases = mocked?.values.filter((each): each is string[] => Array.isArray(each));
				// (a live run takes the first of them alone, and isn't a run in the running list)
				const config = cases === undefined || cases.length === 0 ? given : given["__live"] === true ? { ...given, "args": cases[0] } : { ...given, "args": cases[0], "__cases": cases, "__case": 0 };

				if (typeof config["__runId"] === "string" || config["__live"] === true) {
					return config;
				}

				try {
					const { id } = await rpc.request("runs.begin", { "title": program === "" ? config.name : `${config.name} — ${vscode.workspace.asRelativePath(program)}`, "cwd": program.slice(0, program.lastIndexOf("/")) || "/workspace", "entry": program }, { "timeoutMs": 5000, "waitForResponderMs": 2000 }) as { "id": string };

					return { ...config, "__runId": id };
				} catch {
					return config;
				}
			}
		}),
		vscode.debug.registerDebugAdapterDescriptorFactory("tsval", {
			"createDebugAdapterDescriptor": (session) => new vscode.DebugAdapterInlineImplementation(new TsvalDebugSession(session))
		}),
		// A run of several cases (process.argv mocked with Multiple): when one ends, the next starts — unless it was stopped,
		// which stops them all. Each is its own session (and run), stopping at breakpoints like any.
		vscode.debug.onDidTerminateDebugSession((session) => {
			const config = session.configuration;
			const cases = config["__cases"] as string[][] | undefined;
			const next = (config["__case"] as number | undefined ?? 0) + 1;

			if (session.type === "tsval" && Array.isArray(cases) && next < cases.length && !stoppedByHand.delete(session.id)) {
				const { "__runId": _run, "__launchId": _launch, ...rest } = config;

				void vscode.debug.startDebugging(undefined, { ...rest, "name": `${String(rest.name).replace(/ \(case \d+ of \d+\)$/u, "")} (case ${next + 1} of ${cases.length})`, "args": cases[next], "__case": next } as vscode.DebugConfiguration);
			}
		})
	);
	// Drive the debugger over the hub (debug-mcp's debug_* tools): list, start, breakpoints; each session serves its own.
	serveDebugControl(context, podHub);
}
