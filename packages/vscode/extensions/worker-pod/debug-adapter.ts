/**
 * tsval Debug Adapter (M1) — a `vscode.DebugAdapterInlineImplementation` that runs in the extension host and
 * bridges the DAP (spoken by VS Code's debug UI) to the tsval debug worker (debug-worker.ts), which actually
 * interprets the program with tsval's stepping VM.
 *
 * Division of labor: the worker owns execution and produces a full snapshot on every stop (frames + scopes +
 * variables); this adapter is a thin translator — it maps DAP requests to worker control messages and answers
 * stackTrace/scopes/variables straight out of the latest snapshot. Inline is the only viable shape in-browser
 * (a DebugAdapterServer needs a socket). Time-travel (step-back) and the React/Atomics path arrive in M2/M3.
 */
import * as vscode from "vscode";

interface DapRequest { "seq": number; "type": "request"; "command": string; "arguments"?: Record<string, unknown> }
type Dap = Record<string, unknown>;

interface Snapshot {
	"frames": { "id": number; "name": string; "line": number; "column": number }[];
	"scopes": Record<number, { "name": string; "variablesReference": number; "expensive": boolean }[]>;
	"variables": Record<number, { "name": string; "value": string; "type": string; "variablesReference": number }[]>;
}
type WorkerMessage =
	| { "type": "stopped"; "reason": string; "snapshot": Snapshot; "atomic"?: boolean }
	| { "type": "terminated" }
	| { "type": "output"; "text": string }
	| { "type": "mutation"; "mutation": unknown }
	| { "type": "rendered" }
	| { "type": "history"; "length": number };

class TsvalDebugSession implements vscode.DebugAdapter {
	private readonly sendEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	public readonly onDidSendMessage = this.sendEmitter.event;

	private seq = 1;
	private worker: Worker | undefined;
	private program = "";
	private lines: number[] = [];
	private snapshot: Snapshot | undefined;

	// Shared control word for resuming a SYNCHRONOUS in-handler pause (M3b). When a breakpoint is hit inside a
	// host-invoked guest call the worker blocks on Atomics.wait (it can't receive messages), so we resume it by
	// storing 1 + Atomics.notify rather than postMessage. Needs crossOriginIsolated — the editor sets COI.
	private readonly control = new Int32Array(new SharedArrayBuffer(4));
	private lastStopAtomic = false;

	// The program runs only once BOTH the source is loaded (launch) and configuration is done — so breakpoints
	// set between the `initialized` event and `configurationDone` are registered before the first step.
	private source = "";
	private sourceReady = false;
	private configDone = false;
	private started = false;
	/** React mode: the program renders via ReactDOM, so run it through the M3c reconciler and stream mutations. */
	private reactMode = false;

	private send(message: Dap): void {
		this.sendEmitter.fire({ ...message, "seq": this.seq++ } as vscode.DebugProtocolMessage);
	}

	private respond(request: DapRequest, body?: Dap): void {
		this.send({ "type": "response", "request_seq": request.seq, "success": true, "command": request.command, "body": body ?? {} });
	}

	private event(event: string, body?: Dap): void {
		this.send({ "type": "event", "event": event, "body": body ?? {} });
	}

	public handleMessage(message: vscode.DebugProtocolMessage): void {
		const request = message as unknown as DapRequest;

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
				const points = (args["breakpoints"] as { "line": number }[] | undefined) ?? [];
				this.lines = points.map((point) => point.line);
				this.worker?.postMessage({ "type": "setBreakpoints", "lines": this.lines });
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

			// Host→adapter custom requests (via activeDebugSession.customRequest): a DOM event routed back from
			// the render pane, and a time-travel jump. Both drive the worker.
			case "dispatch":
				this.worker?.postMessage({ "type": "dispatch", "id": args["id"], "event": args["event"] });
				this.respond(request);
				break;

			case "timeTravel":
				this.worker?.postMessage({ "type": "timeTravel", "index": args["index"] });
				this.respond(request);
				break;

			case "launch":
				this.program = String(args["program"] ?? "");
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
				// Hard-stop: terminate() kills the worker even while it's blocked in Atomics.wait (an in-handler
				// pause), which a postMessage could not reach.
				this.worker?.terminate();
				this.worker = undefined;
				this.respond(request);
				this.event("terminated");
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
		const workerUrl = new URL("./lsp/debug-worker.js", location.href);
		workerUrl.searchParams.set("v", String(Date.now()));
		this.worker = new Worker(workerUrl, { "type": "module" });
		this.worker.onmessage = (event: MessageEvent<WorkerMessage>) => { this.onWorker(event.data); };
		this.worker.onerror = (event) => { this.event("output", { "category": "stderr", "output": `[debug-worker] ${event.message}\n` }); };
		this.worker.postMessage({ "type": "launch", "source": this.source, "fileName": this.program, "lines": this.lines, "control": this.control.buffer, "react": this.reactMode });
	}

	/** Resume the worker. An in-handler (atomic) stop is unblocked via the control word + notify; a top-level
	 *  stop is driven by a control message the worker's loop is awaiting. */
	private resume(kind: string): void {
		if (this.lastStopAtomic) {
			Atomics.store(this.control, 0, 1);
			Atomics.notify(this.control, 0);
		} else {
			this.worker?.postMessage({ "type": kind });
		}
	}

	private onWorker(message: WorkerMessage): void {
		switch (message.type) {
			case "stopped":
				this.snapshot = message.snapshot;
				this.lastStopAtomic = message.atomic === true;
				this.event("stopped", { "reason": message.reason, "threadId": 1, "allThreadsStopped": true });
				break;

			case "terminated":
				this.event("terminated");
				this.worker?.terminate();
				this.worker = undefined;
				break;

			case "output":
				this.event("output", { "category": "stdout", "output": message.text + "\n" });
				break;

			// React mode (M3c): forward the render stream to the host page as DAP custom events. The host's
			// debug-preview pane listens via vscode.debug.onDidReceiveDebugSessionCustomEvent and applies them.
			case "mutation":
				this.event("tsvalMutation", { "mutation": message.mutation });
				break;

			case "rendered":
				this.event("tsvalRendered", {});
				break;

			case "history":
				this.event("tsvalHistory", { "length": message.length });
				break;
		}
	}

	public dispose(): void {
		this.worker?.terminate();
		this.sendEmitter.dispose();
	}
}

/**
 * Register the `tsval` debug type: a config provider that supplies a default launch config (bare F5 / the
 * green Run button, no launch.json), and the descriptor factory that hands back a worker-backed session.
 */
export function registerTsvalDebug(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider("tsval", {
			"resolveDebugConfiguration": (_folder, config) => {
				if (config.type === undefined) {
					return { "type": "tsval", "request": "launch", "name": "Debug (tsval)", "program": "${file}" };
				}

				return config;
			}
		}),
		vscode.debug.registerDebugAdapterDescriptorFactory("tsval", {
			"createDebugAdapterDescriptor": () => new vscode.DebugAdapterInlineImplementation(new TsvalDebugSession())
		})
	);
}
