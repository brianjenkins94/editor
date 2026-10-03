/**
 * What's running, in the status bar: the run registry's list (runs.ts, `runs.changed` on the hub) as "▶ 2 running",
 * there only while something is. Its list shows each run — a service (a dev server) or a task (a script), where it came
 * from, how long it's been going — and the last few that ended, with how; picking a running one offers to stop it.
 *
 * It also reports the debug sessions the registry wouldn't otherwise know — F5, an agent's debug_start, a coverage run;
 * not a terminal's (`__runId`) or a dev server's (`__prodId`), which are already its — so they're in the list too.
 */
import type { RunInfo } from "../../runs";
import { createRpcClient } from "@brianjenkins94/hub";
import * as vscode from "vscode";
import { podHub } from "./pod";

/** `3m 20s`, `1h 2m`, `12s`. */
function since(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));

	if (seconds < 60) {
		return seconds + "s";
	}

	return seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function describe(run: RunInfo): string {
	const where = "terminal" in run.origin ? "terminal " + run.origin.terminal : run.origin.other;

	return [run.kind === "service" ? "service" + (run.port === undefined ? "" : " · :" + run.port) : "task", where, run.cwd].join(" · ");
}

export function registerRunning(context: vscode.ExtensionContext): void {
	const item = vscode.window.createStatusBarItem("editor.running", vscode.StatusBarAlignment.Left, 50);
	const rpc = createRpcClient(podHub);
	let runs: RunInfo[] = [];
	/** The debug sessions reported to the registry, by session id; and the ones it asked to stop. */
	const reported = new Map<string, vscode.DebugSession>();
	const stopping = new Set<string>();
	const isOwnRun = (session: vscode.DebugSession): boolean => session.parentSession !== undefined || session.configuration["__runId"] !== undefined || session.configuration["__prodId"] !== undefined;

	item.name = "Running";
	item.command = "editor.running.show";

	const show = (): void => {
		const live = runs.filter((run) => run.state === "running");

		if (live.length === 0) {
			item.hide();

			return;
		}

		item.text = `$(play) ${live.length} running`;
		item.tooltip = live.map((run) => `${run.title} — ${run.kind === "service" ? "service" : "task"}${run.port === undefined ? "" : " on :" + run.port}, ${since(Date.now() - run.startedAt)}`).join("\n");
		item.show();
	};

	context.subscriptions.push(
		vscode.debug.onDidStartDebugSession((session) => {
			if (isOwnRun(session)) {
				return;
			}

			const program = typeof session.configuration["program"] === "string" ? vscode.workspace.asRelativePath(session.configuration["program"]) : undefined;

			reported.set(session.id, session);
			podHub.publish("runs.external.started", { "key": session.id, "title": program === undefined ? session.name : `${session.name} — ${program}`, "cwd": typeof session.configuration["cwd"] === "string" ? session.configuration["cwd"] : vscode.workspace.workspaceFolders?.[0]?.uri.path });
		}),
		vscode.debug.onDidTerminateDebugSession((session) => {
			if (reported.delete(session.id)) {
				podHub.publish("runs.external.ended", { "key": session.id, "stopped": stopping.delete(session.id) });
			}
		}),
		{ "dispose": podHub.subscribe("runs.external.stop", (data) => {
			const session = reported.get(String((data as { "key"?: unknown } | null)?.key));

			if (session !== undefined) {
				stopping.add(session.id);
				void vscode.debug.stopDebugging(session);
			}
		}) },
		item,
		{ "dispose": podHub.subscribe("runs.changed", (data) => {
			runs = Array.isArray(data) ? data as RunInfo[] : [];
			show();
		}) },
		vscode.commands.registerCommand("editor.running.show", async () => {
			// (Asked fresh: the list carries times, and the last change may be a while ago.)
			runs = await rpc.request("runs.list", undefined, { "timeoutMs": 5000 }).then((list) => list as RunInfo[], () => runs);
			show();

			const live = runs.filter((run) => run.state === "running");
			const ended = runs.filter((run) => run.state !== "running");
			type Pick = vscode.QuickPickItem & { "run"?: RunInfo };
			const picks: Pick[] = [
				...live.length === 0 ? [] : [{ "label": "Running", "kind": vscode.QuickPickItemKind.Separator }],
				...live.map((run) => ({ "label": `$(${run.kind === "service" ? "server-process" : "play"}) ${run.title}`, "description": since(Date.now() - run.startedAt), "detail": describe(run), "run": run })),
				...ended.length === 0 ? [] : [{ "label": "Ended", "kind": vscode.QuickPickItemKind.Separator }],
				...ended.map((run) => ({
					"label": `$(${run.state === "failed" ? "error" : run.state === "stopped" ? "debug-stop" : "check"}) ${run.title}`,
					"description": `${run.state === "stopped" ? "stopped" : "exit " + run.exitCode} · after ${since((run.endedAt ?? run.startedAt) - run.startedAt)} · ${since(Date.now() - (run.endedAt ?? run.startedAt))} ago`,
					"detail": describe(run)
				}))
			];

			if (picks.length === 0) {
				void vscode.window.showInformationMessage("Nothing has run yet.");

				return;
			}

			const picked = await vscode.window.showQuickPick(picks, { "title": "Running", "placeHolder": live.length === 0 ? "Nothing is running" : "Pick a running one to stop it" });

			if (picked?.run === undefined) {
				return;
			}

			const choice = await vscode.window.showWarningMessage(`Stop ${picked.run.title}?`, { "modal": false }, "Stop");

			if (choice === "Stop") {
				await rpc.request("runs.stop", { "id": picked.run.id }, { "timeoutMs": 5000 });
			}
		})
	);
}
