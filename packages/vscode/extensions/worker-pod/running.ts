/**
 * What's running, in the status bar: the run registry's list (runs.ts, `runs.changed` on the hub) as "▶ 2 running",
 * there only while something is. Its list shows each run — a service (a dev server) or a task (a script), where it came
 * from, how long it's been going — and the last few that ended, with how; picking a running one offers to stop it.
 *
 * When a run ends it says how — a task that finished, briefly in the status bar; one that failed, or a service that
 * stopped without being asked to, as a notification (with the way back to its terminal). Stopping something says nothing.
 *
 * A dev server whose preview ran slow was profiled (run-profiles.ts): that's said too, once per profile, with its
 * hotspots a pick away — each the app's function that took the time, opened at its line.
 *
 * It also reports the debug sessions the registry wouldn't otherwise know — F5, an agent's debug_start, a coverage run;
 * not a terminal's (`__runId`) or a dev server's (`__prodId`), which are already its — so they're in the list too.
 */
import type { RunInfo, RunProfile } from "../../runs";
import { createRpcClient } from "@brianjenkins94/hub";
import * as vscode from "vscode";
import { takeExitCode } from "./debug-adapter";
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

/** Where a profile's time went: the app's functions, most time first — picking one opens it at its line. */
async function showHotspots(run: RunInfo, profile: RunProfile): Promise<void> {
	type Pick = vscode.QuickPickItem & { "file"?: string; "line"?: number };
	const picks: Pick[] = profile.hotspots.map((spot) => ({
		"label": "$(flame) " + spot.function,
		"description": `${spot.selfMs} ms self · ${spot.totalMs} ms total`,
		"detail": spot.file === undefined ? "(not one of the app's files)" : `${vscode.workspace.asRelativePath(spot.file)}:${spot.line}`,
		"file": spot.file,
		"line": spot.line
	}));

	picks.push({ "label": "$(file) Open the profile", "detail": vscode.workspace.asRelativePath(profile.path), "file": profile.path });

	const picked = await vscode.window.showQuickPick(picks, { "title": `Where ${run.title}'s preview spent its time`, "placeHolder": profile.hotspots.length === 0 ? "None of it in the app's own code" : "Pick one to go to it" });

	if (picked?.file !== undefined) {
		const line = Math.max(0, (picked.line ?? 1) - 1);

		await vscode.window.showTextDocument(vscode.Uri.file(picked.file), { "selection": new vscode.Range(line, 0, line, 0) });
	}
}

/** How a run ended, said once, as it ends. */
function ended(run: RunInfo): void {
	const after = since((run.endedAt ?? Date.now()) - run.startedAt);
	const showTerminal = async (choice: string | undefined): Promise<void> => {
		if (choice === "Show Terminal") {
			await vscode.commands.executeCommand("workbench.action.terminal.focus");
		}
	};
	const actions = "terminal" in run.origin ? ["Show Terminal"] : [];

	if (run.state === "exited" && run.kind === "task") {
		vscode.window.setStatusBarMessage(`$(check) ${run.title} finished in ${after}`, 5000);
	} else if (run.state === "failed") {
		const message = run.kind === "task" ? `${run.title} failed (exit ${run.exitCode}) after ${after}` : `${run.title} stopped unexpectedly (exit ${run.exitCode}) after ${after}`;

		void vscode.window.showErrorMessage(message, ...actions).then(showTerminal);
	} else if (run.state === "exited" && run.kind === "service") {
		void vscode.window.showWarningMessage(`${run.title} stopped by itself after ${after}`, ...actions).then(showTerminal);
	}
}

export function registerRunning(context: vscode.ExtensionContext): void {
	const item = vscode.window.createStatusBarItem("editor.running", vscode.StatusBarAlignment.Left, 50);
	const rpc = createRpcClient(podHub);
	let runs: RunInfo[] = [];
	/** Each run's profiles so far, to tell a new one. */
	const profileCounts = new Map<string, number>();
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
				podHub.publish("runs.external.ended", { "key": session.id, "stopped": stopping.delete(session.id), "exitCode": takeExitCode(session.id) });
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
			const wasRunning = new Set(runs.filter((run) => run.state === "running").map((run) => run.id));

			runs = Array.isArray(data) ? data as RunInfo[] : [];
			show();

			for (const run of runs) {
				if (wasRunning.has(run.id) && run.state !== "running") {
					ended(run);
				}

				// Its preview ran slow, and was profiled.
				const profile = run.profiles?.at(-1);

				if (profile !== undefined && (run.profiles?.length ?? 0) > (profileCounts.get(run.id) ?? 0)) {
					void vscode.window.showInformationMessage(`${run.title}'s preview ran slow, so it was profiled.`, "Show Hotspots").then((choice) => {
						if (choice === "Show Hotspots") {
							void showHotspots(run, profile);
						}
					});
				}

				profileCounts.set(run.id, run.profiles?.length ?? 0);
			}
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
				...live.map((run) => ({ "label": `$(${run.kind === "service" ? "server-process" : "play"}) ${run.title}`, "description": since(Date.now() - run.startedAt) + (run.profiles === undefined ? "" : ` · $(flame) ${run.profiles.length} profile${run.profiles.length === 1 ? "" : "s"}`), "detail": describe(run), "run": run })),
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

			const profile = picked.run.profiles?.at(-1);
			const choice = await vscode.window.showWarningMessage(`Stop ${picked.run.title}?`, { "modal": false }, "Stop", ...profile === undefined ? [] : ["Show Hotspots"]);

			if (choice === "Stop") {
				await rpc.request("runs.stop", { "id": picked.run.id }, { "timeoutMs": 5000 });
			} else if (choice === "Show Hotspots" && profile !== undefined) {
				await showHotspots(picked.run, profile);
			}
		})
	);
}
