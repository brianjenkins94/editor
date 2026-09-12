/**
 * M0 debug spike — a MINIMAL inline Debug Adapter, hand-rolled against the DAP wire shapes (no
 * `@vscode/debugadapter` dependency). Its only job is to prove the plumbing: that this monaco-vscode-api
 * build can register a debug adapter, show gutter breakpoints, run an F5 launch, and surface a stopped
 * state with a call stack + Variables. It executes NOTHING — every value is stubbed. The real tsval-backed
 * session (worker + Atomics pause, snapshot time-travel) replaces `TsvalDebugSession` in M1+.
 *
 * Registered as a `vscode.DebugAdapterInlineImplementation` (the only viable shape in-browser — a
 * DebugAdapterServer needs a socket port). The adapter is `vscode.DebugAdapter`: an `onDidSendMessage`
 * event we fire with responses/events, and a `handleMessage` we drive off the incoming request `command`.
 */
import * as vscode from "vscode";

/** Loose DAP message shapes — enough for this stub; the real types live in `@vscode/debugprotocol`. */
interface DapRequest { "seq": number; "type": "request"; "command": string; "arguments"?: Record<string, unknown> }
type Dap = Record<string, unknown>;

class TsvalDebugSession implements vscode.DebugAdapter {
	private readonly sendEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	public readonly onDidSendMessage = this.sendEmitter.event;

	private seq = 1;
	/** The program being "debugged" and the first breakpoint line — echoed back in the stack frame. */
	private program = "";
	private breakLine = 1;

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
				// Advertise the one capability we honor: the client waits for `configurationDone`.
				this.respond(request, { "supportsConfigurationDoneRequest": true });
				this.event("initialized");
				break;

			case "setBreakpoints": {
				const source = (args["source"] as { "path"?: string } | undefined) ?? {};
				const points = (args["breakpoints"] as { "line": number }[] | undefined) ?? [];

				if (typeof source.path === "string") {
					this.program = source.path;
				}

				if (points.length > 0) {
					this.breakLine = points[0].line;
				}

				// Verify every breakpoint at the requested line (the stub has no real program to reject against).
				this.respond(request, { "breakpoints": points.map((point) => ({ "verified": true, "line": point.line })) });
				break;
			}

			case "setExceptionBreakpoints":
				this.respond(request, { "breakpoints": [] });
				break;

			case "configurationDone":
				this.respond(request);
				break;

			case "launch":
				if (typeof args["program"] === "string") {
					this.program = args["program"] as string;
				}

				this.respond(request);
				// Land on the first breakpoint immediately — the whole point of the spike.
				this.event("stopped", { "reason": "breakpoint", "threadId": 1, "allThreadsStopped": true });
				break;

			case "threads":
				this.respond(request, { "threads": [{ "id": 1, "name": "main (tsval M0)" }] });
				break;

			case "stackTrace":
				this.respond(request, {
					"stackFrames": [{ "id": 1, "name": "App", "line": this.breakLine, "column": 1, "source": { "path": this.program } }],
					"totalFrames": 1
				});
				break;

			case "scopes":
				this.respond(request, { "scopes": [{ "name": "Locals", "variablesReference": 1000, "expensive": false }] });
				break;

			case "variables":
				// The proof shot: real rows in the Variables pane.
				this.respond(request, {
					"variables": [
						{ "name": "count", "value": "0", "type": "number", "variablesReference": 0 },
						{ "name": "__spike", "value": "\"M0: debug plumbing works\"", "type": "string", "variablesReference": 0 }
					]
				});
				break;

			// Step commands keep the session paused so the toolbar visibly works; Continue ends it.
			case "next":
			case "stepIn":
			case "stepOut":
				this.respond(request);
				this.breakLine += 1;
				this.event("stopped", { "reason": "step", "threadId": 1, "allThreadsStopped": true });
				break;

			case "continue":
				this.respond(request, { "allThreadsContinued": true });
				this.event("terminated");
				break;

			case "disconnect":
			case "terminate":
				this.respond(request);
				this.event("terminated");
				break;

			default:
				// Unknown request: acknowledge so the client isn't left waiting.
				this.respond(request);
				break;
		}
	}

	public dispose(): void {
		this.sendEmitter.dispose();
	}
}

/**
 * Register the M0 debug type. A config provider supplies a default launch config so plain F5 works with no
 * `launch.json`, and the descriptor factory hands back the inline stub session.
 */
export function registerDebugSpike(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider("tsval", {
			"resolveDebugConfiguration": (_folder, config) => {
				// Empty config (bare F5, no launch.json) → a default that debugs the active file.
				if (config.type === undefined) {
					return { "type": "tsval", "request": "launch", "name": "Debug (tsval M0)", "program": "${file}" };
				}

				return config;
			}
		}),
		vscode.debug.registerDebugAdapterDescriptorFactory("tsval", {
			"createDebugAdapterDescriptor": () => new vscode.DebugAdapterInlineImplementation(new TsvalDebugSession())
		})
	);
}
