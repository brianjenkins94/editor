/**
 * Live runs (LIVE-VALUES.md, *Live runs, as you type*): the program file you're typing in runs again whenever typing
 * pauses — a tsval debug session like any other, so the margin shows what it did, but quiet (no toolbar, status bar,
 * view or console; stopping at nothing; not in the running list) and harmless (what it can't make it skips: the debug
 * worker's `live`). An edit while one runs stops it; none starts while a run of yours (F5, ▷, the terminal) of the
 * same file is going — that run is what its margin shows (a service of yours running elsewhere doesn't stop them).
 * Off with `tsval.liveRuns`.
 */
import * as vscode from "vscode";
import { appRootOf } from "./launch";

/** How long typing has to pause before the file runs again. */
const PAUSE_MS = 400;

/** What a live run runs: a JavaScript or TypeScript file (RUNNING.md's programs), saved somewhere or not. */
const PROGRAM = /\.(?:m|c)?[jt]sx?$/u;

export function registerLiveRuns(context: vscode.ExtensionContext): void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** The live run going, by its file. */
	const running = new Map<string, vscode.DebugSession>();
	/** Every debug session going. */
	const sessions = new Set<vscode.DebugSession>();
	const enabled = (): boolean => vscode.workspace.getConfiguration("tsval").get<boolean>("liveRuns", true);
	const isLive = (session: vscode.DebugSession): boolean => session.type === "tsval" && session.configuration["__live"] === true;
	/** A run of yours of `path` going (anything but a live run): it's what that file's margin shows, so a live run waits. */
	const yours = (path: string): boolean => [...sessions].some((session) => !isLive(session) && session.configuration["program"] === path);

	const stop = (path: string): void => {
		const session = running.get(path);

		if (session !== undefined) {
			running.delete(path);
			void vscode.debug.stopDebugging(session);
		}
	};

	const start = async (document: vscode.TextDocument): Promise<void> => {
		const path = document.uri.path;

		// (an app's file runs in its page, not here — RUNNING.md, step 4)
		if (!enabled() || yours(path) || running.has(path) || await appRootOf(path) !== undefined) {
			return;
		}

		await vscode.debug.startDebugging(undefined, { "type": "tsval", "request": "launch", "name": `${path.split("/").pop()!} (live)`, "program": path, "internalConsoleOptions": "neverOpen", "__live": true }, { "suppressDebugToolbar": true, "suppressDebugStatusbar": true, "suppressDebugView": true, "suppressSaveBeforeStart": true });
	};

	context.subscriptions.push(
		vscode.debug.onDidStartDebugSession((session) => {
			sessions.add(session);

			if (isLive(session)) {
				running.set(String(session.configuration["program"]), session);
			}
		}),
		vscode.debug.onDidTerminateDebugSession((session) => {
			sessions.delete(session);

			const path = String(session.configuration["program"]);

			if (running.get(path) === session) {
				running.delete(path);
			}
		}),
		vscode.workspace.onDidChangeTextDocument((event) => {
			const { document } = event;

			if (event.contentChanges.length === 0 || document.uri.scheme !== "file" || !PROGRAM.test(document.uri.path) || vscode.window.activeTextEditor?.document !== document || !enabled()) {
				return;
			}

			// The edit makes the run going stale: stop it, and run again once typing pauses.
			stop(document.uri.path);
			clearTimeout(timer);
			timer = setTimeout(() => { void start(document); }, PAUSE_MS);
		}),
		{ "dispose": () => { clearTimeout(timer); } }
	);
}
