/**
 * What every debugger's runs tell the editor — tsval's, and any interpreter plugged in as `run.debugger` (editor-contrib's
 * starting point, contrib/README.md) — read the one way: the run contract's custom events (@brianjenkins94/run-contract)
 * into what core shows and keeps.
 *
 * - `values`: the margin's values (`values.session.<id>`, live-values.ts), as they come;
 * - `ended`: a file's values go, and how the run ended short is marked (`values.ended`) — for a debugger that tells none,
 *   the program's, as its session ends;
 * - `coverage`: the run's evidence (`evidence.observed`, evidence.ts — coverage.ts reads the event itself);
 * - `effects`: what the run did to the world, kept for its envelope in the run ledger (silo-store's setEffects);
 * - `ask`: a capability stop's question, on its line — answered as capability-stops.ts says;
 * - `recorded`: what an allowed call returned, for a rule to give back (silo-store's recordResult);
 * - `listening`: the run is a service on a port (`node.listening.<run>`: the running list, its preview).
 *
 * A run a terminal started (`__startedBy: "terminal"`, its `__runId` the terminal's run) prints there — its `output`
 * events' stdout and stderr (`node.out.<run>`) — and reads what's typed there (`node.stdin.<run>`, the `stdin` request).
 *
 * Every debugger is given the policy its calls are decided by as it launches (`__policy`).
 *
 * Another extension's debugger is also made a run in core's registry here (`runs.begin`, as tsval's launch asks for its
 * own; its end the run's, extension.ts's `node.exit`, as any session's).
 */
import type { AskEvent, CoverageEvent, EffectsEvent, EndedEvent, ListeningEvent, RecordedEvent, StdinRequest, ValuesEvent } from "@brianjenkins94/run-contract";
import { createRpcClient } from "@brianjenkins94/hub";
import * as vscode from "vscode";
import { recordResult, setEffects } from "../capabilities/silo-store";
import { asked, policyFor } from "./capability-stops";
import { podHub } from "./pod";

/** This extension's own debuggers, which make their runs themselves: tsval (its launch), and a production run (a
 *  preview's). */
const OWN = new Set(["tsval", "production"]);

/** The terminal run `session` was started as, if a terminal started it. */
function terminalRun(session: vscode.DebugSession): string | undefined {
	const runId = session.configuration["__runId"];

	return session.configuration["__startedBy"] === "terminal" && typeof runId === "string" ? runId : undefined;
}

export function registerDebugEvents(context: vscode.ExtensionContext): void {
	const rpc = createRpcClient(podHub);
	/** The sessions that told an `ended`: their margins are cleared already. */
	const ended = new Set<string>();
	/** Each terminal's run's stdin subscription, by its session. */
	const typing = new Map<string, () => void>();

	context.subscriptions.push(
		// A run in the running list, known by one id from start to end — but a live run, which isn't one (live-run.ts).
		vscode.debug.registerDebugConfigurationProvider("*", {
			"resolveDebugConfigurationWithSubstitutedVariables": async (_folder, given) => {
				// Every debugger decides its gated calls by the editor's policy (the run contract's `__policy`).
				const config = { ...given, "__policy": await policyFor() };

				if (OWN.has(config.type) || typeof config["__runId"] === "string" || config["__live"] === true) {
					return config;
				}

				const program = typeof config["program"] === "string" ? config["program"] : "";

				try {
					const { id } = await rpc.request("runs.begin", { "title": program === "" ? config.name : `${config.name} — ${vscode.workspace.asRelativePath(program)}`, "cwd": program.slice(0, program.lastIndexOf("/")) || "/workspace", "entry": program, "runtime": config.type }, { "timeoutMs": 5000, "waitForResponderMs": 2000 }) as { "id": string };

					return { ...config, "__runId": id };
				} catch {
					return config; // without core, it runs all the same, unrecorded
				}
			}
		}),
		vscode.debug.onDidReceiveDebugSessionCustomEvent(({ session, event, body }) => {
			const runId = session.configuration["__runId"];

			switch (event) {
				case "values":
					podHub.publish(`values.session.${session.id}`, body as ValuesEvent);
					break;

				case "ended":
					ended.add(session.id);
					podHub.publish("values.ended", { "session": session.id, ...body as EndedEvent });
					break;

				// A run's evidence is of the text that ran — each of its files with its own (MODULES.md).
				case "coverage": {
					if (typeof runId !== "string") {
						break;
					}

					const coverage = body as CoverageEvent;
					const files = (coverage.files ?? []).map((other) => ({ "file": other.file, "source": other.source ?? "", "statements": other.statements, "sites": other.sites }));

					podHub.publish("evidence.observed", { "runId": runId, "file": coverage.file, "source": coverage.source ?? "", "statements": coverage.statements, "sites": coverage.sites, ...files.length === 0 ? {} : { "files": files } });
					break;
				}

				case "effects":
					if (typeof runId === "string") {
						setEffects(runId, (body as EffectsEvent).effects);
					}

					break;

				case "ask":
					asked(podHub, session, body as AskEvent);
					break;

				case "listening":
					if (typeof runId === "string") {
						podHub.publish(`node.listening.${runId}`, { "port": (body as ListeningEvent).port });
					}

					break;

				case "recorded": {
					const { capability, resource, value } = body as RecordedEvent;

					void recordResult(capability, resource, value).catch(() => undefined);
					break;
				}

				default:
					break;
			}
		}),
		// A terminal's run: its output printed there, what's typed there its stdin.
		vscode.debug.registerDebugAdapterTrackerFactory("*", {
			"createDebugAdapterTracker": (session) => {
				const runId = terminalRun(session);

				return runId === undefined ? undefined : {
					"onDidSendMessage": (message: { "type"?: string; "event"?: string; "body"?: { "category"?: string; "output"?: string } }) => {
						const category = message.body?.category ?? "console";

						if (message.type === "event" && message.event === "output" && (category === "stdout" || category === "stderr")) {
							podHub.publish(`node.out.${runId}`, { "stream": category === "stderr" ? "err" : "out", "data": message.body?.output ?? "" });
						}
					}
				};
			}
		}),
		vscode.debug.onDidStartDebugSession((session) => {
			const runId = terminalRun(session);

			if (runId !== undefined) {
				typing.set(session.id, podHub.subscribe(`node.stdin.${runId}`, (data) => {
					const { "data": text, end } = (data ?? {}) as { "data"?: string; "end"?: boolean };

					void session.customRequest("stdin", { "data": text ?? "", ...end === true ? { "end": true } : {} } satisfies StdinRequest);
				}));
			}
		}),
		vscode.debug.onDidTerminateDebugSession((session) => {
			typing.get(session.id)?.();
			typing.delete(session.id);

			if (!ended.delete(session.id) && !OWN.has(session.type) && typeof session.configuration["program"] === "string") {
				podHub.publish("values.ended", { "session": session.id, "file": session.configuration["program"] });
			}
		})
	);
}
