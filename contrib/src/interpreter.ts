// The interpreter: a debug adapter the editor starts for every run of a file — the ▷ button, the terminal, and live
// runs as you type all go through `vscode.debug.startDebugging`. It speaks the Debug Adapter Protocol, so breakpoints,
// stepping, the Variables view and the Debug Console are VS Code's own. What the editor draws on top of the code —
// values in the margin, coverage — comes from the run contract's custom events (@brianjenkins94/run-contract).
import type { Events } from "@brianjenkins94/run-contract";
import * as vscode from "vscode";

interface Message { "seq": number; "type": string; "command"?: string; "arguments"?: Record<string, unknown> }

export class InterpreterSession implements vscode.DebugAdapter {
	private readonly emitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	readonly onDidSendMessage = this.emitter.event;
	private seq = 0;

	handleMessage(message: vscode.DebugProtocolMessage): void {
		const request = message as Message;

		switch (request.command) {
			case "initialize":
				this.respond(request, { "supportsConfigurationDoneRequest": true });
				this.event("initialized");
				break;
			case "launch":
				this.respond(request);
				void this.run(String(request.arguments?.["program"] ?? ""));
				break;
			case "setBreakpoints":
				// TODO: keep them, and stop at them as the program runs.
				this.respond(request, { "breakpoints": ((request.arguments?.["breakpoints"] as { "line": number }[] | undefined) ?? []).map((point) => ({ "verified": false, "line": point.line })) });
				break;
			case "threads":
				this.respond(request, { "threads": [{ "id": 1, "name": "main" }] });
				break;
			case "stackTrace":
				// TODO: the frames when stopped.
				this.respond(request, { "stackFrames": [], "totalFrames": 0 });
				break;
			case "scopes":
				this.respond(request, { "scopes": [] });
				break;
			case "variables":
				this.respond(request, { "variables": [] });
				break;
			default:
				// configurationDone, continue, next, stepIn, stepOut, pause, disconnect: TODO as the interpreter grows.
				this.respond(request);
		}
	}

	/** Run `program` — read it, interpret it — telling the editor what happened as it goes. */
	private async run(program: string): Promise<void> {
		const source = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(program)));

		// TODO: interpret `source`. Write what it prints with `output`, and tell values as they happen:
		this.output(`would run ${program} (${source.length} characters)\n`);
		this.tell("values", { "file": program, "source": source, "values": [], "calls": [], "dropped": 0 });
		// …and, as it ends, every statement that could run with how often it did.
		this.tell("coverage", { "file": program, "source": source, "statements": [], "sites": [] });
		this.event("exited", { "exitCode": 0 });
		this.event("terminated");
	}

	/** Tell the editor one of the contract's events. */
	private tell<Name extends keyof Events>(name: Name, body: Events[Name]): void {
		this.event(name, body);
	}

	private output(text: string): void {
		this.event("output", { "category": "stdout", "output": text });
	}

	private event(event: string, body?: unknown): void {
		this.seq += 1;
		this.emitter.fire({ "seq": this.seq, "type": "event", "event": event, ...body === undefined ? {} : { "body": body } });
	}

	private respond(request: Message, body?: unknown): void {
		this.seq += 1;
		this.emitter.fire({ "seq": this.seq, "type": "response", "request_seq": request.seq, "success": true, "command": request.command, ...body === undefined ? {} : { "body": body } });
	}

	dispose(): void {
		this.emitter.dispose();
	}
}
