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
 * And what Run means, whichever debugger it starts — each launch resolved here:
 *
 * - its policy (`__policy`): what its gated calls are decided by;
 * - an app's file runs the app (RUNNING.md, step 4) — its dev server, its preview — not a session;
 * - `process.argv`, when a rule gives it (RULES.md; the margin's Mock): `args`, the first value — the rest each a run after
 *   it (`__cases`), unless one is stopped by hand;
 * - a run in core's registry (`runs.begin`), known by one id from start to end — its end the run's, with its exit code
 *   (DAP's `exited`: extension.ts's `node.exit`).
 */
import type { AskEvent, CoverageEvent, EffectsEvent, EndedEvent, ListeningEvent, RecordedEvent, StdinRequest, ValuesEvent } from "@brianjenkins94/run-contract";
import { createRpcClient } from "@brianjenkins94/hub";
import { given as givenBy } from "@brianjenkins94/util/silo/policy";
import * as vscode from "vscode";
import { recordResult, setEffects } from "../capabilities/silo-store";
import { asked, policyFor } from "./capability-stops";
import { appRootOf, runApp } from "./launch";
import { podHub } from "./pod";

/** A preview's run: worker-pod's own, made by the preview (extension.ts), and nothing of Run's. */
const PRODUCTION = "production";

/** How each session ended, as its DAP messages say (a debugger in this extension host — another's isn't seen): its exit
 *  code (`exited`), and whether it was stopped by hand (disconnected before it said it was done). */
const ends = new Map<string, { "exitCode": number; "stoppedByHand": boolean; "done": boolean }>();


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
				if (given.type === PRODUCTION) {
					return given;
				}

				const program = typeof given["program"] === "string" ? given["program"] : "";

				// F5 on an app's file: the app runs. (Run's own launches decided that already; a terminal's `node` and an
				// ordering's replay are what they say.)
				if (given["__launchId"] === undefined && given["__startedBy"] !== "terminal" && given["__live"] !== true && given["eventLoop"] === undefined && given["replay"] === undefined && program !== "") {
					const app = await appRootOf(program);

					if (app !== undefined) {
						await runApp(app).catch((error: unknown) => { void vscode.window.showErrorMessage(`Couldn't run: ${error instanceof Error ? error.message : String(error)}`); });

						return undefined;
					}
				}

				// Every debugger decides its gated calls by the editor's policy (the run contract's `__policy`).
				const policy = await policyFor();
				// No `args`: what a rule gives the file's process.argv, if one does. (A live run takes the first alone.)
				const mocked = Array.isArray(given["args"]) || Array.isArray(given["__cases"]) || given["replay"] !== undefined || program === "" ? undefined : givenBy(policy, { "program": vscode.workspace.asRelativePath(vscode.Uri.file(program), false) }, "process.argv");
				const cases = mocked?.values.filter((each): each is string[] => Array.isArray(each));
				const config = { ...given, "__policy": policy, ...cases === undefined || cases.length === 0 ? {} : given["__live"] === true ? { "args": cases[0] } : { "args": cases[0], "__cases": cases, "__case": 0 } };

				if (typeof config["__runId"] === "string" || config["__live"] === true) {
					return config;
				}

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
		// How a session ends — and a terminal's run's output, printed there.
		vscode.debug.registerDebugAdapterTrackerFactory("*", {
			"createDebugAdapterTracker": (session) => {
				const runId = terminalRun(session);
				const end = { "exitCode": 0, "stoppedByHand": false, "done": false };

				ends.set(session.id, end);

				return {
					"onDidSendMessage": (message: { "type"?: string; "event"?: string; "body"?: { "category"?: string; "output"?: string; "exitCode"?: number } }) => {
						if (message.type !== "event") {
							return;
						}

						if (message.event === "exited") {
							end.exitCode = message.body?.exitCode ?? 0;
							end.done = true;
						} else if (message.event === "terminated") {
							end.done = true;
						} else if (runId !== undefined && message.event === "output") {
							const category = message.body?.category ?? "console";

							if (category === "stdout" || category === "stderr") {
								podHub.publish(`node.out.${runId}`, { "stream": category === "stderr" ? "err" : "out", "data": message.body?.output ?? "" });
							}
						}
					},
					"onWillReceiveMessage": (message: { "type"?: string; "command"?: string }) => {
						if (message.type === "request" && (message.command === "disconnect" || message.command === "terminate") && !end.done) {
							end.stoppedByHand = true;
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

			if (!ended.delete(session.id) && session.type !== PRODUCTION && typeof session.configuration["program"] === "string") {
				podHub.publish("values.ended", { "session": session.id, "file": session.configuration["program"] });
			}

			const end = ends.get(session.id);
			const config = session.configuration;

			ends.delete(session.id);

			// Its run ends with it, with its exit code.
			if (typeof config["__runId"] === "string") {
				podHub.publish(`node.exit.${config["__runId"]}`, { "exitCode": end?.exitCode ?? 0 });
			}

			// A run of several cases: when one ends, the next starts — unless it was stopped by hand, which stops them all.
			// Each is its own session (and run), stopping at breakpoints like any.
			const cases = config["__cases"] as string[][] | undefined;
			const next = (config["__case"] as number | undefined ?? 0) + 1;

			if (Array.isArray(cases) && next < cases.length && end?.stoppedByHand !== true) {
				const { "__runId": _run, "__launchId": _launch, "__policy": _policy, ...rest } = config;

				void vscode.debug.startDebugging(undefined, { ...rest, "name": `${String(rest.name).replace(/ \(case \d+ of \d+\)$/u, "")} (case ${next + 1} of ${cases.length})`, "args": cases[next], "__case": next } as vscode.DebugConfiguration);
			}
		})
	);
}
