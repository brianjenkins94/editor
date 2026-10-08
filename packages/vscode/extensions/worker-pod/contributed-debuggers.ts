/**
 * Another extension's debugger — an interpreter plugged in from editor-contrib's template (contrib/README.md) — wired
 * into the editor as tsval is: each of its sessions a run in core's registry (`runs.begin`, as tsval's launch asks; its
 * end the run's, extension.ts's `node.exit`, as any session's), and its custom events told on the pod hub as tsval's
 * adapter tells them — `values` as the margin's values (`values.session.<id>` as they come, `values.ended` as it ends),
 * `coverage` as the run's evidence (`evidence.observed`; coverage.ts reads the event itself).
 */
import { createRpcClient } from "@brianjenkins94/hub";
import * as vscode from "vscode";
import { podHub } from "./pod";

/** This extension's own debuggers: tsval tells the hub itself, and a production run is a preview's. */
const OWN = new Set(["tsval", "production"]);

export function registerContributedDebuggers(context: vscode.ExtensionContext): void {
	const rpc = createRpcClient(podHub);

	context.subscriptions.push(
		// A run in the running list, known by one id from start to end — but a live run, which isn't one (live-run.ts).
		vscode.debug.registerDebugConfigurationProvider("*", {
			"resolveDebugConfigurationWithSubstitutedVariables": async (_folder, config) => {
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
			if (OWN.has(session.type)) {
				return;
			}

			if (event === "values") {
				podHub.publish(`values.session.${session.id}`, body);
			} else if (event === "coverage" && typeof session.configuration["__runId"] === "string") {
				podHub.publish("evidence.observed", { ...body as object, "runId": session.configuration["__runId"] });
			}
		}),
		vscode.debug.onDidTerminateDebugSession((session) => {
			if (!OWN.has(session.type) && typeof session.configuration["program"] === "string") {
				podHub.publish("values.ended", { "session": session.id, "file": session.configuration["program"] });
			}
		})
	);
}
