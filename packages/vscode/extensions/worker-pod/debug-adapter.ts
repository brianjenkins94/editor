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
	| { "type": "stopped"; "reason": string; "snapshot": Snapshot }
	| { "type": "terminated" }
	| { "type": "output"; "text": string };

class TsvalDebugSession implements vscode.DebugAdapter {
	private readonly sendEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	public readonly onDidSendMessage = this.sendEmitter.event;

	private seq = 1;
	private worker: Worker | undefined;
	private program = "";
	private lines: number[] = [];
	private snapshot: Snapshot | undefined;

	// The program runs only once BOTH the source is loaded (launch) and configuration is done — so breakpoints
	// set between the `initialized` event and `configurationDone` are registered before the first step.
	private source = "";
	private sourceReady = false;
	private configDone = false;
	private started = false;

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
				this.respond(request, { "supportsConfigurationDoneRequest": true, "supportsTerminateRequest": true });
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
				this.worker?.postMessage({ "type": "continue" });
				this.respond(request, { "allThreadsContinued": true });
				break;

			case "next":
				this.worker?.postMessage({ "type": "next" });
				this.respond(request);
				break;

			case "stepIn":
				this.worker?.postMessage({ "type": "stepIn" });
				this.respond(request);
				break;

			case "stepOut":
				this.worker?.postMessage({ "type": "stepOut" });
				this.respond(request);
				break;

			case "disconnect":
			case "terminate":
				this.worker?.postMessage({ "type": "disconnect" });
				this.respond(request);
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
		this.worker.postMessage({ "type": "launch", "source": this.source, "fileName": this.program, "lines": this.lines });
	}

	private onWorker(message: WorkerMessage): void {
		switch (message.type) {
			case "stopped":
				this.snapshot = message.snapshot;
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
