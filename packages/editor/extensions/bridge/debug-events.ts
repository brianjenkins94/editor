import type { AskEvent, CoverageEvent, ListeningEvent, RecordedEvent, StdinRequest } from "@brianjenkins94/editor-api";
import { takeEffects } from "@brianjenkins94/editor-api/effects";
import { recordedResults, recordResult } from "@brianjenkins94/editor-api/policy";
import { createRpcClient, serve } from "@brianjenkins94/hub";
import * as vscode from "vscode";
import { asked, policyFor } from "./capability-stops";
import { bridgeHub } from "./hub";
import { byRules } from "./placed-rules";

const ends = new Map<string, { "exitCode": number }>();

function terminalRun(session: vscode.DebugSession): string | undefined {
	const runId = session.configuration["__runId"];

	return session.configuration["__startedBy"] === "terminal" && typeof runId === "string"
		? runId
		: undefined;
}

export function registerDebugEvents(context: vscode.ExtensionContext): void {
	serve(bridgeHub, "run.effects", (args) => ({
		"effects": takeEffects((args as { "run": string }).run)
	}));

	const rpc = createRpcClient(bridgeHub);
	const typing = new Map<string, () => void>();

	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider("*", {
			"resolveDebugConfigurationWithSubstitutedVariables": async (_folder, given) => {
				const program = typeof given["program"] === "string"
					? given["program"]
					: "";
				const policy = await policyFor();
				const live = given["__live"] === true;
				const config = {
					...given,
					"__policy": policy,
					...await byRules(policy, program, given),
					...live
						? { "__recorded": await recordedResults().catch(() => ({})) }
						: {}
				};

				if (typeof config["__runId"] === "string" || live) {
					return config;
				}

				try {
					const { id } = await rpc.request("runs.begin", {
						"title": program === ""
							? config.name
							: `${config.name} — ${vscode.workspace.asRelativePath(program)}`,
						"cwd": program.slice(0, program.lastIndexOf("/")) || "/workspace",
						"entry": program,
						"runtime": config.type
					}, { "timeoutMs": 5000, "waitForResponderMs": 2000 }) as { "id": string };

					return { ...config, "__runId": id };
				} catch {
					return config;
				}
			}
		}),
		vscode.debug.onDidReceiveDebugSessionCustomEvent(({ session, event, body }) => {
			const runId = session.configuration["__runId"];

			switch (event) {
				case "ask":
					asked(session, body as AskEvent);
					break;

				case "recorded": {
					const { capability, resource, value, request } = body as RecordedEvent;

					void recordResult(capability, resource, value, request).catch(() => undefined);
					break;
				}

				case "coverage": {
					if (typeof runId !== "string") {
						break;
					}

					const coverage = body as CoverageEvent;
					const files = (coverage.files ?? []).map((other) => ({
						"file": other.file,
						"source": other.source ?? "",
						"statements": other.statements,
						"sites": other.sites
					}));

					bridgeHub.publish("evidence.observed", {
						"runId": runId,
						"file": coverage.file,
						"source": coverage.source ?? "",
						"statements": coverage.statements,
						"sites": coverage.sites,
						...files.length === 0
							? {}
							: { "files": files },
						...coverage.packages === undefined
							? {}
							: { "packages": coverage.packages }
					});
					break;
				}

				case "effects":
					if (typeof runId === "string") {
						bridgeHub.publish("evidence.effects", { "runId": runId, "effects": (body as { "effects"?: unknown }).effects });
					}

					break;

				case "listening":
					if (typeof runId === "string") {
						bridgeHub.publish(`node.listening.${runId}`, { "port": (body as ListeningEvent).port });
					}

					break;

				default:
					break;
			}
		}),
		vscode.debug.registerDebugAdapterTrackerFactory("*", {
			"createDebugAdapterTracker": (session) => {
				const runId = terminalRun(session);
				const end = { "exitCode": 0 };

				ends.set(session.id, end);

				return {
					"onDidSendMessage": (message: { "type"?: string; "event"?: string; "body"?: { "category"?: string; "output"?: string; "exitCode"?: number } }) => {
						if (message.type !== "event") {
							return;
						}

						if (message.event === "exited") {
							end.exitCode = message.body?.exitCode ?? 0;
						} else if (runId !== undefined && message.event === "output") {
							const category = message.body?.category ?? "console";

							if (category === "stdout" || category === "stderr") {
								bridgeHub.publish(`node.out.${runId}`, {
									"stream": category === "stderr"
										? "err"
										: "out",
									"data": message.body?.output ?? ""
								});
							}
						}
					}
				};
			}
		}),
		vscode.debug.onDidStartDebugSession((session) => {
			const runId = terminalRun(session);

			if (runId !== undefined) {
				typing.set(session.id, bridgeHub.subscribe(`node.stdin.${runId}`, (data) => {
					const { "data": text, end } = (data ?? {}) as { "data"?: string; "end"?: boolean };

					void session.customRequest("stdin", {
						"data": text ?? "",
						...end === true
							? { "end": true }
							: {}
					} satisfies StdinRequest);
				}));
			}
		}),
		vscode.debug.onDidTerminateDebugSession((session) => {
			typing.get(session.id)?.();
			typing.delete(session.id);

			const end = ends.get(session.id);
			const config = session.configuration;

			ends.delete(session.id);

			if (typeof config["__runId"] === "string") {
				bridgeHub.publish(`node.exit.${config["__runId"]}`, { "exitCode": end?.exitCode ?? 0 });
			}
		})
	);
}
