import { appRootOf } from "@brianjenkins94/editor-api/lifecycle";
import { logger } from "@brianjenkins94/util/logger";
import * as vscode from "vscode";
import { runOf } from "./run-file";

const SAVE_DEBOUNCE_MS = 250;

const SAME_TEXT_MS = 1000;

const ENDED_KEPT = 200;

const PROGRAM = /(?<!\.d)\.[cm]?[jt]sx?$/u;

const log = logger({ "source": "live-run" });

const readText = async (file: string): Promise<string | undefined> => Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.file(file))).then((bytes) => new TextDecoder().decode(bytes), () => undefined);
const enabled = (): boolean => vscode.workspace.getConfiguration("run").get<boolean>("liveRuns", true);
const isLive = (session: vscode.DebugSession): boolean => session.configuration["__live"] === true;
const isQuiet = (session: vscode.DebugSession): boolean => session.configuration.internalConsoleOptions === "neverOpen";
const isProgram = (document: vscode.TextDocument): boolean => document.uri.scheme === "file" && PROGRAM.test(document.uri.path);

export function registerLiveRuns(context: vscode.ExtensionContext): void {
	let saved: ReturnType<typeof setTimeout> | undefined;
	let ticking: ReturnType<typeof setInterval> | undefined;
	const running = new Map<string, vscode.DebugSession>();
	const starting = new Set<string>();
	const last = new Map<string, { "text": string; "at": number }>();
	const edited = new Set<string>();
	const sessions = new Map<string, vscode.DebugSession>();
	const ended = new Set<string>();
	const programOf = (session: vscode.DebugSession): string => String(session.configuration["program"]);
	let quietFirst = false;
	let yoursStarted = false;
	let told = false;
	const tell = (): void => {
		const going = running.size + starting.size > 0 && [...sessions.values()].every(isLive);

		if (going !== told) {
			told = going;
			void vscode.commands.executeCommand("setContext", "run.liveGoing", going);
		}
	};
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
			"resolveDebugConfiguration": (_folder, config) => (quietFirst && config.internalConsoleOptions === undefined && vscode.workspace.getConfiguration("debug").get<string>("internalConsoleOptions") === "openOnFirstSessionStart" ? { ...config, "internalConsoleOptions": "openOnSessionStart" } : config)
		}),
		vscode.debug.onDidStartDebugSession((session) => {
			if (ended.has(session.id)) {
				return;
			}

			sessions.set(session.id, session);

			if (isLive(session)) {
				if (yours(programOf(session))) {
					void vscode.debug.stopDebugging(session);
				} else {
					running.set(programOf(session), session);
				}
			} else {
				stop(programOf(session));
			}

			if (isQuiet(session)) {
				quietFirst ||= !yoursStarted;
			} else {
				yoursStarted = true;
				quietFirst = false;
			}

			tell();
		}),
		vscode.debug.onDidTerminateDebugSession((session) => {
			sessions.delete(session.id);
			ended.add(session.id);

			if (ended.size > ENDED_KEPT) {
				ended.delete(ended.values().next().value as string);
			}

			if (running.get(programOf(session))?.id === session.id) {
				running.delete(programOf(session));
			}

			tell();
		}),
		vscode.workspace.onDidChangeTextDocument((event) => {
			const { document } = event;

			if (event.contentChanges.length > 0 && document.isDirty && isProgram(document) && vscode.window.activeTextEditor?.document === document) {
				edited.add(document.uri.path);
				stop(document.uri.path);
			}
		}),
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
