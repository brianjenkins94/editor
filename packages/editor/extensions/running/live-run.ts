/**
 * Live runs (RUNTIME-EVIDENCE.md, *Live runs*): the program file you're editing runs again on each save, and on an interval
 * once it's been edited, while its text differs from what its last run ran — a debug session like any other (tsval's, or `run.debugger`'s), so
 * the margin shows what it did, but quiet (no toolbar, status bar, view or console; stopping at nothing; not in the
 * running list) and harmless (nobody is watching, so it asks nothing: what it can't make it gives back as it was
 * recorded, else skips — the debug worker's `live`; another debugger is told `__live` and `__recorded`, and should do the
 * same). An edit while one runs stops it; none starts while a run of yours (F5, ▷, the terminal) of the same file is
 * going — that run is what its margin shows (a service of yours running elsewhere doesn't stop them). Off with
 * `run.liveRuns`; the interval is `run.liveRuns.interval` (seconds, 0: saves only).
 *
 * A save runs again what the edit reached, too (RUNNING.md, *Unattended runs*: "What runs"): each test whose trace on the
 * saved file (lib util/silo/traces' `test`) holds a declaration that's no longer in its text — it executed code that
 * changed. Their test files run live, one at a time, after the file itself; an edit cancels what's still queued.
 */
import type { RunTrace } from "@brianjenkins94/util/silo/traces";
import { annotations } from "@brianjenkins94/editor-api/annotations";
import { appRootOf } from "@brianjenkins94/editor-api/lifecycle";
import { localTracesPath } from "@brianjenkins94/util/silo/layout";
import { parseTraces } from "@brianjenkins94/util/silo/traces";
import * as vscode from "vscode";

/** Saves this close together are one run: the last. */
const SAVE_DEBOUNCE_MS = 250;

/** A run of the same text started this recently (the interval's, or the save before) isn't started again by a save. */
const SAME_TEXT_MS = 1000;

/** What a live run runs: a JavaScript or TypeScript file (RUNNING.md's programs), saved somewhere or not. */
const PROGRAM = /\.(?:m|c)?[jt]sx?$/u;

/** The debugger a run of a file starts (`run.debugger`, the bridge's setting: tsval, or another extension's debug type). */
const runDebugger = (): string => vscode.workspace.getConfiguration("run").get<string>("debugger") || "tsval";
const readText = async (file: string): Promise<string | undefined> => Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.file(file))).then((bytes) => new TextDecoder().decode(bytes), () => undefined);

/** The test files whose tests executed code of `path` that `text` no longer has: each test's trace on it holds a
 *  declaration (a BABLR span id) its spans don't. In the order they were kept; none when the text doesn't parse. */
export async function reachedTests(path: string, text: string): Promise<string[]> {
	const root = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(path))?.uri ?? vscode.workspace.workspaceFolders?.[0]?.uri;

	if (root === undefined) {
		return [];
	}

	const kept = await readText(vscode.Uri.joinPath(root, localTracesPath(vscode.workspace.asRelativePath(vscode.Uri.file(path), false))).path);
	const tests = parseTraces(kept ?? "").filter((trace): trace is RunTrace & Required<Pick<RunTrace, "test" | "declarations">> => trace.test !== undefined && trace.declarations !== undefined);

	if (tests.length === 0) {
		return [];
	}

	const answer = await annotations(vscode.commands).spans(text).catch(() => undefined);

	if (answer === undefined || !("value" in answer)) {
		return [];
	}

	const ids = new Set(answer.value.map((span) => span.id));
	const files = tests.filter((trace) => trace.declarations.some((id) => !ids.has(id))).map((trace) => vscode.Uri.joinPath(root, trace.test.id.split(" › ")[0]).path);

	return [...new Set(files)].filter((file) => file !== path);
}

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
	/** Every debug session going. */
	const sessions = new Set<vscode.DebugSession>();
	/** The test files a save reached, still to run (one at a time); and the one running now. */
	let queued: string[] = [];
	let selected: string | undefined;
	const enabled = (): boolean => vscode.workspace.getConfiguration("run").get<boolean>("liveRuns", true);
	const isLive = (session: vscode.DebugSession): boolean => session.configuration["__live"] === true;
	/** A run of yours of `path` going (anything but a live run): it's what that file's margin shows, so a live run waits. */
	const yours = (path: string): boolean => [...sessions].some((session) => !isLive(session) && session.configuration["program"] === path);
	const isProgram = (document: vscode.TextDocument): boolean => document.uri.scheme === "file" && PROGRAM.test(document.uri.path);

	const stop = (path: string): void => {
		const session = running.get(path);

		if (session !== undefined) {
			running.delete(path);
			void vscode.debug.stopDebugging(session);
		}
	};

	const start = async (document: vscode.TextDocument): Promise<void> => {
		await startPath(document.uri.path, document.getText());
	};

	/** Start a live run of `path` (its text `text`): whether one started. */
	const startPath = async (path: string, text: string): Promise<boolean> => {
		// (an app's file runs in its page, not here — RUNNING.md, *Apps*)
		if (!enabled() || yours(path) || running.has(path) || starting.has(path) || await appRootOf(path, readText) !== undefined) {
			return false;
		}

		starting.add(path);
		edited.delete(path);
		last.set(path, { "text": text, "at": Date.now() });

		try {
			return await vscode.debug.startDebugging(undefined, { "type": runDebugger(), "request": "launch", "name": `${path.split("/").pop()} (live)`, "program": path, "internalConsoleOptions": "neverOpen", "__live": true }, { "suppressDebugToolbar": true, "suppressDebugStatusbar": true, "suppressDebugView": true, "suppressSaveBeforeStart": true });
		} finally {
			starting.delete(path);
		}
	};

	/** The next test file a save reached, once nothing it queued is running. */
	const next = async (): Promise<void> => {
		if (selected !== undefined && running.has(selected)) {
			return;
		}

		selected = queued.shift();

		if (selected !== undefined) {
			const text = await readText(selected);

			// (one that can't run now — a run of yours of it going, say — is skipped)
			if (text === undefined || !await startPath(selected, text)) {
				selected = undefined;
				await next();
			}
		}
	};

	/** What a save reached: queued behind what's queued already, each file once. */
	const select = async (document: vscode.TextDocument): Promise<void> => {
		const files = await reachedTests(document.uri.path, document.getText());

		queued = [...new Set([...queued, ...files])].filter((file) => file !== selected);
		await next();
	};

	/** Every `run.liveRuns.interval` seconds: the file in front of you, if it's changed since its last run. */
	const tick = (): void => {
		clearInterval(ticking);

		const seconds = vscode.workspace.getConfiguration("run").get<number>("liveRuns.interval", 5);

		ticking = undefined;

		if (seconds > 0) {
			ticking = setInterval(() => {
				const document = vscode.window.activeTextEditor?.document;

				if (document !== undefined && isProgram(document) && enabled() && edited.has(document.uri.path) && document.getText() !== last.get(document.uri.path)?.text) {
					void start(document);
				}
			}, seconds * 1000);
		}
	};

	tick();

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

			if (path === selected) {
				selected = undefined;
				void next();
			}
		}),
		vscode.workspace.onDidChangeTextDocument((event) => {
			const { document } = event;

			if (event.contentChanges.length === 0 || !isProgram(document) || vscode.window.activeTextEditor?.document !== document || !enabled()) {
				return;
			}

			// The edit makes the run going stale: stop it — and what a save had queued. The next save, or the interval, runs it
			// again.
			edited.add(document.uri.path);
			stop(document.uri.path);
			queued = [];

			if (selected !== undefined) {
				stop(selected);
				selected = undefined;
			}
		}),
		// A save runs it: the last of a burst of saves, unless that text started a run just now.
		vscode.workspace.onDidSaveTextDocument((document) => {
			if (!isProgram(document) || !enabled()) {
				return;
			}

			clearTimeout(saved);
			saved = setTimeout(() => {
				const before = last.get(document.uri.path);

				if (before?.text === document.getText() && Date.now() - before.at < SAME_TEXT_MS) {
					return;
				}

				stop(document.uri.path);
				void start(document);
				void select(document);
			}, SAVE_DEBOUNCE_MS);
		}),
		// Run a file again now (a rule just saved for its calls, say), whatever ran before.
		vscode.commands.registerCommand("run.live.again", async (value: unknown) => {
			const uri = value instanceof vscode.Uri ? value.toString() : value;
			const document = vscode.workspace.textDocuments.find((each) => each.uri.toString() === uri);

			if (document !== undefined && isProgram(document)) {
				stop(document.uri.path);
				await start(document);
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
