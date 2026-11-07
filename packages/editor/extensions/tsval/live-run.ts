/**
 * Live runs (RUNTIME-EVIDENCE.md, *Live runs*): the file you're editing runs again on each save, and on an interval once it's
 * been edited while its text differs from what its last run ran, so the Margin stays current. It's a debug session like any
 * other, but quiet (no toolbar, status bar, view or console, stopping at nothing, not in the running list) and harmless:
 * nobody is watching, so it asks nothing (the debug worker's `live`). An edit stops the one going. None starts while a run of
 * yours of the same file is going, since that's what its Margin shows, and starting one of yours stops a live one. Off with
 * `run.liveRuns`; the interval is `run.liveRuns.interval` (seconds, 0: saves only).
 *
 * VS Code binds F5 to starting only while nothing's debugging, and a live run counts: pressed just after a save, F5 would do
 * nothing. So while only live runs are going, `run.liveGoing` binds it (this extension's package.json). And it opens the Debug
 * Console on a page's first session, which a live run would use up: the first of yours is told to open it.
 */
import { appRootOf } from "@brianjenkins94/editor-api/lifecycle";
import { logger } from "@brianjenkins94/util/logger";
import * as vscode from "vscode";
import { runOf } from "./run-file";

/** Saves this close together are one run: the last. */
const SAVE_DEBOUNCE_MS = 250;

/** A run of the same text started this recently (the interval's, or the save before) isn't started again by a save. */
const SAME_TEXT_MS = 1000;

/** The ended sessions remembered, by id. */
const ENDED_KEPT = 200;

/** What a live run runs: a JavaScript or TypeScript file (not one of declarations). */
const PROGRAM = /(?<!\.d)\.[cm]?[jt]sx?$/u;

const log = logger({ "source": "live-run" });

const readText = async (file: string): Promise<string | undefined> => Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.file(file))).then((bytes) => new TextDecoder().decode(bytes), () => undefined);
const enabled = (): boolean => vscode.workspace.getConfiguration("run").get<boolean>("liveRuns", true);
const isLive = (session: vscode.DebugSession): boolean => session.configuration["__live"] === true;
const isProgram = (document: vscode.TextDocument): boolean => document.uri.scheme === "file" && PROGRAM.test(document.uri.path);

export function registerLiveRuns(context: vscode.ExtensionContext): void {
	let saved: ReturnType<typeof setTimeout> | undefined;
	let ticking: ReturnType<typeof setInterval> | undefined;
	/** The live run going, by its file. */
	const running = new Map<string, vscode.DebugSession>();
	/** The files a live run is being started for, until its session starts. */
	const starting = new Set<string>();
	/** What each file's last live run ran, and when it started. */
	const last = new Map<string, { "text": string; "at": number }>();
	/** The files edited since their last live run: what the interval runs (opening a file doesn't run it). */
	const edited = new Set<string>();
	/** Every debug session going, by its id. An ended one is known by its id too, as a short run on a busy host can be told
	 *  ended before it's told started, and kept as going it would hold up that file's live runs for good. */
	const sessions = new Map<string, vscode.DebugSession>();
	const ended = new Set<string>();
	const programOf = (session: vscode.DebugSession): string => String(session.configuration["program"]);
	/** Whether a live run has started and one of yours hasn't, for the Debug Console (above). */
	let liveFirst = false;
	let yoursStarted = false;
	let told = false;
	/** Whether only live runs are going, for F5 (above). */
	const tell = (): void => {
		const going = running.size + starting.size > 0 && [...sessions.values()].every(isLive);

		if (going !== told) {
			told = going;
			void vscode.commands.executeCommand("setContext", "run.liveGoing", going);
		}
	};
	/** A run of yours of `path` going: anything but a live run. */
	const yours = (path: string): boolean => [...sessions.values()].some((session) => !isLive(session) && programOf(session) === path);

	const stop = (path: string): void => {
		const session = running.get(path);

		if (session !== undefined) {
			running.delete(path);
			void vscode.debug.stopDebugging(session);
		}
	};

	const start = async (document: vscode.TextDocument, why: string): Promise<void> => {
		const path = document.uri.path;

		// (an app's file runs in its page, not here: RUNNING.md, *Apps*)
		if (!enabled() || yours(path) || running.has(path) || starting.has(path) || await appRootOf(path, readText) !== undefined) {
			return;
		}

		starting.add(path);
		tell();
		edited.delete(path);
		last.set(path, { "text": document.getText(), "at": Date.now() });

		await log.span("editor.extensions.tsval.live-run.start", { "caller": why, "path": path }, async () => vscode.debug.startDebugging(undefined, { ...runOf(document.uri), "name": `${path.split("/").pop() ?? path} (live)`, "internalConsoleOptions": "neverOpen", "__live": true }, { "suppressDebugToolbar": true, "suppressDebugStatusbar": true, "suppressDebugView": true, "suppressSaveBeforeStart": true })).finally(() => {
			starting.delete(path);
			tell();
		});
	};

	/** Every `run.liveRuns.interval` seconds: the file in front of you, if it's changed since its last run. */
	const tick = (): void => {
		clearInterval(ticking);
		ticking = undefined;

		const seconds = vscode.workspace.getConfiguration("run").get<number>("liveRuns.interval", 5);

		if (seconds > 0) {
			ticking = setInterval(() => {
				const document = vscode.window.activeTextEditor?.document;

				if (document !== undefined && isProgram(document) && edited.has(document.uri.path) && document.getText() !== last.get(document.uri.path)?.text) {
					void start(document, "interval");
				}
			}, seconds * 1000);
		}
	};

	tick();

	context.subscriptions.push(
		vscode.debug.registerDebugConfigurationProvider("*", {
			"resolveDebugConfiguration": (_folder, config) => (liveFirst && config["__live"] !== true && config.internalConsoleOptions === undefined && vscode.workspace.getConfiguration("debug").get<string>("internalConsoleOptions") === "openOnFirstSessionStart" ? { ...config, "internalConsoleOptions": "openOnSessionStart" } : config)
		}),
		vscode.debug.onDidStartDebugSession((session) => {
			if (ended.has(session.id)) {
				return;
			}

			sessions.set(session.id, session);

			if (isLive(session)) {
				running.set(programOf(session), session);
				liveFirst ||= !yoursStarted;
			} else {
				yoursStarted = true;
				liveFirst = false;
				stop(programOf(session));
			}

			tell();
		}),
		vscode.debug.onDidTerminateDebugSession((session) => {
			sessions.delete(session.id);
			ended.add(session.id);

			// (the latest ended ones are enough: a start told late is told just after its end)
			if (ended.size > ENDED_KEPT) {
				ended.delete(ended.values().next().value as string);
			}

			if (running.get(programOf(session))?.id === session.id) {
				running.delete(programOf(session));
			}

			tell();
		}),
		// The edit makes the run going stale. The next save, or the interval, runs it again.
		vscode.workspace.onDidChangeTextDocument((event) => {
			const { document } = event;

			if (event.contentChanges.length > 0 && isProgram(document) && vscode.window.activeTextEditor?.document === document) {
				edited.add(document.uri.path);
				stop(document.uri.path);
			}
		}),
		// A save runs it: the last of a burst of saves, unless that text started a run just now.
		vscode.workspace.onDidSaveTextDocument((document) => {
			if (!isProgram(document)) {
				return;
			}

			clearTimeout(saved);
			saved = setTimeout(() => {
				const before = last.get(document.uri.path);

				if (before?.text !== document.getText() || Date.now() - before.at >= SAME_TEXT_MS) {
					stop(document.uri.path);
					void start(document, "save");
				}
			}, SAVE_DEBOUNCE_MS);
		}),
		// Run a file again now, whatever ran before (a rule just saved for its calls, say).
		vscode.commands.registerCommand("run.live.again", async (value: unknown) => {
			const uri = value instanceof vscode.Uri ? value.toString() : value;
			const document = vscode.workspace.textDocuments.find((each) => each.uri.toString() === uri);

			if (document !== undefined && isProgram(document)) {
				stop(document.uri.path);
				await start(document, "again");
			}
		}),
		vscode.workspace.onDidChangeConfiguration((event) => {
			if (event.affectsConfiguration("run.liveRuns.interval")) {
				tick();
			}
		}),
		{
			"dispose": () => {
				clearTimeout(saved);
				clearInterval(ticking);
			}
		}
	);
}
