/**
 * The `production` debug adapter — presents an almostnode "production" run (the vite preview today) as a VS Code
 * debug session so a run shows up in Run and Debug with a controller, instead of only a terminal process. This
 * is the second of the "two debug modes": tsval (interpreter — full step + time-travel) and production
 * (almostnode real runtime). almostnode runs real code with NO interpreter hooks, so there's no line-stepping
 * here — it's RUN-CONTROL: running / Stop / terminate, plus output in the Debug Console. Full stepping stays
 * tsval's job (`node <file>` auto-attaches there).
 *
 * The run itself lives where it always did (the terminal's `vite` → node-runner). This adapter just rides hub channels the
 * run's driver publishes — `production.out.<id>` (→ Debug Console), `production.exit.<id>` (→ terminated) — and on
 * Stop publishes `production.stop.<id>` so the driver tears the run down. One brain, thin adapter — the same shape as
 * the capability interceptors. It's declared a LAUNCH, though it starts nothing itself: Stop does end the run, and
 * VS Code calls an attach's stop "Disconnect" — as if the run would go on without it, which it never does.
 */
import type { Events } from "@brianjenkins94/editor-api";
import type { Hub } from "@brianjenkins94/hub";
import * as vscode from "vscode";

type Dap = Record<string, unknown>;

/** Each preview's run's session, by its port. */
const previews = new Map<number, ProductionDebugSession>();

/** Tell the run contract's `event` from the preview on `port`'s run (its recorded stops' `values`) — none without one. */
export function tellPreview<Name extends keyof Events>(port: number, name: Name, body: Events[Name]): void {
	previews.get(port)?.tell(name, body);
}

interface DapRequest { "type": "request"; "seq": number; "command": string; "arguments"?: Dap }

class ProductionDebugSession implements vscode.DebugAdapter {
	public readonly onDidSendMessage: vscode.Event<vscode.DebugProtocolMessage>;

	private readonly sendEmitter = new vscode.EventEmitter<vscode.DebugProtocolMessage>();
	private seq = 1;
	private id = "";
	private readonly offs: (() => void)[] = [];
	private readonly hub: Hub;
	private port: number | undefined;

	public constructor(hub: Hub) {
		this.hub = hub;
		this.onDidSendMessage = this.sendEmitter.event;
	}

	public handleMessage(message: vscode.DebugProtocolMessage): void {
		const request = message as DapRequest;

		if (request.type !== "request") {
			return;
		}

		const args = request.arguments ?? {};

		switch (request.command) {
			case "initialize":
				// Run-control only: terminate (Stop), no breakpoints/stepping/step-back (almostnode has no hooks).
				this.respond(request, { "supportsTerminateRequest": true });
				this.event("initialized");
				break;

			case "launch":
				this.id = (args["__prodId"] as string | undefined) ?? "";
				this.port = typeof args["__port"] === "number" ? args["__port"] : undefined;

				if (this.port !== undefined) {
					previews.set(this.port, this);
				}

				// The run's driver streams its output here; relay it to the Debug Console.
				this.offs.push(this.hub.subscribe(`production.out.${this.id}`, (data) => {
					const chunk = data as { "stream"?: "out" | "err"; "data"?: string };

					this.event("output", { "category": chunk.stream === "err" ? "stderr" : "stdout", "output": chunk.data ?? "" });
				}));
				// The run ended (or was stopped) → end the debug session.
				this.offs.push(this.hub.subscribe(`production.exit.${this.id}`, () => {
					this.event("terminated");
				}));
				this.respond(request);
				break;

			case "configurationDone":
				this.respond(request);
				break;

			case "threads":
				this.respond(request, { "threads": [{ "id": 1, "name": "production" }] });
				break;

			case "continue":
				// Nothing to resume — a production run is always running; report it so the toolbar shows the run state.
				this.respond(request, { "allThreadsContinued": true });
				break;

			case "disconnect":
			case "terminate":
				// Stop button / session close → tell the driver to tear the run down (it will emit production.exit).
				if (this.id !== "") {
					this.hub.publish(`production.stop.${this.id}`, {});
				}

				this.respond(request);
				break;

			default:
				this.respond(request);
				break;
		}
	}

	/** A run contract event, from the run. */
	public tell<Name extends keyof Events>(name: Name, body: Events[Name]): void {
		this.event(name, body as unknown as Dap);
	}

	public dispose(): void {
		if (this.port !== undefined && previews.get(this.port) === this) {
			previews.delete(this.port);
		}

		for (const off of this.offs) {
			off();
		}

		this.offs.length = 0;
		this.sendEmitter.dispose();
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
}

/**
 * Register the `production` debug type: a config provider (bare launch config) + the descriptor factory that
 * hands back a hub-riding session. `hub` is the pod hub — the run driver's `production.*` channels federate to it.
 */
export function registerProductionDebug(context: vscode.ExtensionContext, hub: Hub): void {
	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider("production", {
			"resolveDebugConfiguration": (_folder, config) => (config.type === undefined ? { "type": "production", "request": "launch", "name": "Production run" } : config)
		}),
		vscode.debug.registerDebugAdapterDescriptorFactory("production", {
			"createDebugAdapterDescriptor": () => new vscode.DebugAdapterInlineImplementation(new ProductionDebugSession(hub))
		})
	);
}
