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
import { createRpcClient, portTransport } from "@brianjenkins94/hub";
import { logger } from "@brianjenkins94/util/logger";
import * as vscode from "vscode";

import { EMPTY_POLICY, type Policy } from "@brianjenkins94/util/silo/policy";
import { loadEffectivePolicy } from "../capabilities/silo-store";
import type { ControllableSession, DebugAction, DebugOutcome, DebugState } from "./debug-control";
import { registerSession, serveDebugControl } from "./debug-control";
import type { Control, CoverageReport, Snapshot, StepAction, WorkerEvent } from "./debug-protocol";
import { lifecycleOfSource } from "../../lifecycle";
import { controlSubject, eventSubject } from "./debug-protocol";
import { podHub } from "./pod";
import { runTask } from "./tasks";

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
	// Effective capability policy snapshot (.silo base + my overrides), read at launch and handed to the worker so
	// it pre-arms capability breakpoints (a gated call hard-stops at its line). Empty when there's no policy — then
	// every undecided dangerous call breaks (firewall default).
	private policy: Policy = EMPTY_POLICY;
	private sourceReady = false;
	private configDone = false;
	private started = false;
	/** React mode: the program renders via ReactDOM, so run it through the M3c reconciler and stream mutations. */
	private reactMode = false;
	/** Run Without Debugging (or a coverage run): breakpoints don't stop it. Capability breakpoints still do — they're
	 *  the policy gate, not a debugging aid. */
	private noDebug = false;
	/** The latest coverage the worker reported, and whether the final one has gone out as the `coverage` event. */
	private coverage: CoverageReport | undefined;
	private coverageSent = false;
	private readonly coverageWaiters = new Set<(report: CoverageReport) => void>();

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
					"code": this.source.split("\n")[frame.line - 1]?.trim(),
					"locals": (scope === undefined ? [] : this.snapshot?.variables[scope.variablesReference] ?? []).map(({ name, value, type }) => ({ "name": name, "value": value, "type": type }))
				}
				: {}),
			"output": [...this.output]
		};
	}

	public act(action: DebugAction, signal: AbortSignal): Promise<DebugOutcome> {
		if (this.state !== "stopped") {
			throw new Error(`session is ${this.state}, not stopped` + (this.state === "idle" ? " (the app is mounted and waiting for events — set a breakpoint in a handler and interact with the preview)" : ""));
		}

		const next = this.nextSettle(signal);

		this.output = [];
		// The action didn't come from VS Code's UI, so tell it (and the toolbar mirror) the session is running again.
		this.event("continued", { "threadId": 1, "allThreadsContinued": true });
		this.resume(action);

		return next;
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

	private event(event: string, body?: Dap): void {
		this.send({ "type": "event", "event": event, "body": body ?? {} });
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
				this.respond(request, { "supportsConfigurationDoneRequest": true, "supportsTerminateRequest": true, "supportsStepBack": true });
				this.event("initialized");
				break;

			case "setBreakpoints": {
				// Per file: only the program's own breakpoints apply (another file's lines aren't lines of this program).
				const points = (args["breakpoints"] as { "line": number }[] | undefined) ?? [];
				const path = String((args["source"] as { "path"?: string } | undefined)?.path ?? "");
				const applies = this.program === "" || path === this.program;

				this.breakpointLines.set(path, points.map((point) => point.line));
				this.lines = this.noDebug ? [] : this.breakpointLines.get(this.program) ?? [];

				if (path === this.program) {
					this.control({ "type": "setBreakpoints", "lines": this.lines });
				}

				this.respond(request, { "breakpoints": points.map((point) => ({ "verified": applies, "line": point.line })) });
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

			// Host→adapter custom requests (via activeDebugSession.customRequest): a DOM event routed back from
			// the render pane, and a time-travel jump. Both drive the worker.
			case "dispatch": {
				const trace = this.startAction("dispatch");

				this.control({ "type": "dispatch", "id": args["id"] as number, "event": args["event"] as string }, trace);
				this.respond(request);
				break;
			}

			case "timeTravel":
				this.control({ "type": "timeTravel", "index": args["index"] as number });
				this.respond(request);
				break;

			// The program's statement coverage so far (a CoverageReport); once it has ended, its final coverage.
			case "getCoverage":
				void this.currentCoverage(5000).then((report) => { this.respond(request, report as unknown as Dap); });
				break;

			case "launch":
				this.program = String(args["program"] ?? "");
				this.noDebug = args["noDebug"] === true;
				this.lines = this.noDebug ? [] : this.breakpointLines.get(this.program) ?? [];
				this.respond(request);
				void this.loadSource();
				break;

			case "threads":
				this.respond(request, { "threads": [{ "id": 1, "name": "tsval" }] });
				break;

			case "stackTrace":
				this.respond(request, {
					"stackFrames": (this.snapshot?.frames ?? []).map((frame) => ({ ...frame, "source": { "path": this.program } })),
					"totalFrames": this.snapshot?.frames.length ?? 0
				});
				break;

			case "scopes":
				this.respond(request, { "scopes": this.snapshot?.scopes[args["frameId"] as number] ?? [] });
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
				// Stopped early: ask for the coverage so far first, briefly — a worker blocked in Atomics.wait (an
				// in-handler pause) can't answer, and then the last report stands. Then hard-stop: terminate() kills
				// the worker even while it's blocked, which a postMessage could not reach.
				void this.currentCoverage(500).then((report) => {
					this.sendFinalCoverage(report);
					this.endAction();
					this.closeWorker();
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
			const document = await vscode.workspace.openTextDocument(vscode.Uri.file(this.program));

			this.source = document.getText();
			// React mode if the program mounts via ReactDOM — then run it through the reconciler (M3c) rather
			// than as a plain script.
			this.reactMode = /\bReactDOM\b/u.test(this.source) || /\bReact\s*\.\s*createElement\b/u.test(this.source);
			this.policy = await this.loadPolicy();
			this.sourceReady = true;
			this.maybeStart();
		} catch (error) {
			this.event("output", { "category": "stderr", "output": `Failed to read ${this.program}: ${String(error)}\n` });
			this.event("terminated");
		}
	}

	/** The effective `.silo/` policy — base `policy.json` + my `<user>.policy.json` overrides, exactly as the
	 *  runtime enforcer sees it — as the capability-breakpoint set, so the tsval debugger pre-arms the same rules
	 *  that would actually gate a production run. Empty policy if absent/malformed/no workspace. */
	private async loadPolicy(): Promise<Policy> {
		try {
			return await loadEffectivePolicy();
		} catch (error) {
			return EMPTY_POLICY;
		}
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

			this.control({ "type": "launch", "source": this.source, "fileName": this.program, "lines": this.lines, "control": this.sharedControl?.buffer, "react": this.reactMode, "policy": this.policy }, trace);
		});
	}

	/** A control message for this session's worker; `trace` continues an adapter action's trace in the work it starts. */
	private control(message: Control, trace?: { "traceId": string; "parentSpanId": string }): void {
		if (this.worker !== undefined) {
			podHub.publish(controlSubject(this.id), message, { "traceContext": trace });
		}
	}

	/** The worker's coverage now, or — when it's gone or doesn't answer within `timeoutMs` — the last it reported. */
	private currentCoverage(timeoutMs: number): Promise<CoverageReport> {
		const fallback = (): CoverageReport => this.coverage ?? { "file": this.program, "statements": [] };

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
			this.event("coverage", report as unknown as Dap);
		}
	}

	private closeWorker(): void {
		this.offEvents?.();
		this.offEvents = undefined;
		this.podUnlink?.();
		this.podUnlink = undefined;
		this.worker?.terminate();
		this.worker = undefined;
	}

	/** Resume the worker. An in-handler (atomic) stop is unblocked via the control word + notify; a top-level
	 *  stop is driven by a control message the worker's loop is awaiting. */
	private resume(kind: StepAction): void {
		const trace = this.startAction(kind);

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
				this.event("stopped", { "reason": message.reason, "threadId": 1, "allThreadsStopped": true });
				this.settle("stopped");
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
				this.event("terminated");
				this.closeWorker();
				this.settle("terminated");
				break;

			case "output":
				this.event("output", { "category": message.stream ?? "stdout", "output": message.text + "\n" });

				if (this.output.length < 200) {
					this.output.push(message.text);
				}

				break;

			// React mode: the render stream itself goes straight from the worker to the render surface; these just end
			// the action that caused it.
			case "rendered":
				this.endAction(); // React mount finished — close the launch action span (React launch has no "stopped")
				this.settle("idle");
				break;

			case "history":
				this.endAction(); // a dispatched re-render finished — close the dispatch action span
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
export function registerTsvalDebug(context: vscode.ExtensionContext): void {
	const rpc = createRpcClient(podHub);

	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider("tsval", {
			"resolveDebugConfiguration": (_folder, config) => {
				if (config.type === undefined) {
					const document = vscode.window.activeTextEditor?.document;

					if (document !== undefined && document.uri.scheme === "file" && lifecycleOfSource(document.getText()).lifecycle === "service") {
						const path = document.uri.path;
						const cwd = path.slice(0, path.lastIndexOf("/")) || "/";
						const command = "node " + path.slice(cwd.length + 1);

						void vscode.tasks.executeTask(runTask(command, command, cwd, "file", true));

						return undefined; // not a debug session: a task runs it, in a terminal
					}

					// eslint-disable-next-line no-template-curly-in-string -- ${file} is a VS Code launch-config variable, not a JS template literal
					return { "type": "tsval", "request": "launch", "name": "Debug (tsval)", "program": "${file}" };
				}

				return config;
			},
			// Every session is a run in core's registry, known by one id from start to end: a terminal's `node` brings its
			// own (`__runId`); one VS Code started (F5, debug_start) asks for one here, once `${file}` is the real path.
			// Without core (no answer), it runs all the same, unrecorded.
			"resolveDebugConfigurationWithSubstitutedVariables": async (_folder, config) => {
				if (typeof config["__runId"] === "string") {
					return config;
				}

				const program = typeof config["program"] === "string" ? config["program"] : "";

				try {
					const { id } = await rpc.request("runs.begin", { "title": program === "" ? config.name : `${config.name} — ${vscode.workspace.asRelativePath(program)}`, "cwd": program.slice(0, program.lastIndexOf("/")) || "/workspace" }, { "timeoutMs": 5000, "waitForResponderMs": 2000 }) as { "id": string };

					return { ...config, "__runId": id };
				} catch {
					return config;
				}
			}
		}),
		vscode.debug.registerDebugAdapterDescriptorFactory("tsval", {
			"createDebugAdapterDescriptor": (session) => new vscode.DebugAdapterInlineImplementation(new TsvalDebugSession(session))
		})
	);
	// Drive the debugger over the hub (debug-mcp's debug_* tools): list, start, breakpoints; each session serves its own.
	serveDebugControl(context, podHub);
}
