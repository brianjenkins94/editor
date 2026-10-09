/**
 * Running — what's running, in one place, from VS Code's public API alone, so it works the same in a desktop VS Code:
 *   • commands in a terminal, from shell integration (`window.onDidStart/EndTerminalShellExecution`: the command line,
 *     where it ran, its exit code) — our terminal speaks it (terminal-integration.ts), as desktop shells do;
 *   • debug sessions (F5, an agent's), from `vscode.debug` — not the ones a terminal command or a dev server started for
 *     itself, which that command already stands for;
 *   • tasks, from `vscode.tasks` (a background task is a service).
 *
 * Each is a service (keeps running until stopped) or a task (runs to completion): a task's `isBackground`, or a guess
 * from the command — its script in package.json, the file it runs (lifecycle.ts). "▶ 2 running" sits in the status bar
 * while anything does; its list stops one (a terminal command by Ctrl-C in its terminal, as you would) and shows how the
 * last few ended. A task that finishes says so in the status bar; one that fails, or a service that stops by itself,
 * says so as a notification. Stopping something says nothing.
 *
 * Not every command is a run: a quick `ls` or `cd` would be noise. A command counts when it starts a program (node,
 * npm, vite, …) or keeps going past a second.
 */
import type { LifecycleGuess } from "../../lifecycle";
import * as vscode from "vscode";
import { lifecycleOfScript, lifecycleOfSource } from "../../lifecycle";

type RunState = "running" | "exited" | "failed" | "stopped" | "ended";

interface Run {
	"title": string;
	"kind": "service" | "task";
	/** Where it came from: `terminal bash`, `Run and Debug`, `task`. */
	"where": string;
	"startedAt": number;
	"endedAt"?: number;
	"state": RunState;
	"exitCode"?: number;
	/** Whether it's shown: a program, or a command that kept going (see `counts`). */
	"counted": boolean;
	/** We asked it to stop (so its end isn't news). */
	"stopping": boolean;
	"stop": () => void;
	"terminal"?: vscode.Terminal;
}

/** Programs, by the first word of a command line: running one is a run, however briefly. */
const PROGRAMS = new Set(["node", "npm", "npx", "pnpm", "yarn", "bun", "deno", "tsx", "ts-node", "vite", "next", "python", "python3", "make", "cargo", "go"]);
/** A command that isn't a program counts once it has run this long. */
const COUNTS_AFTER_MS = 1000;
/** How many ended runs the list keeps. */
const KEEP_ENDED = 10;

/** `3m 20s`, `1h 2m`, `12s`. */
function since(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));

	if (seconds < 60) {
		return seconds + "s";
	}

	return seconds < 3600 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

async function readText(uri: vscode.Uri): Promise<string | undefined> {
	try {
		return new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
	} catch {
		return undefined;
	}
}

/** The nearest package.json's scripts, from `cwd` up. */
async function scriptsNear(cwd: vscode.Uri): Promise<Record<string, string>> {
	for (let dir = cwd; ; dir = vscode.Uri.joinPath(dir, "..")) {
		const text = await readText(vscode.Uri.joinPath(dir, "package.json"));

		if (text !== undefined) {
			try {
				return (JSON.parse(text) as { "scripts"?: Record<string, string> }).scripts ?? {};
			} catch {
				return {};
			}
		}

		if (dir.path === "/" || dir.path === "") {
			return {};
		}
	}
}

/** Service or task, from a command line: `npm run x` by its script, `node file` by its source, otherwise by itself.
 *  (`depth`: a script that runs a script, but not forever.) */
async function classify(commandLine: string, cwd: vscode.Uri | undefined, depth = 0): Promise<LifecycleGuess> {
	const words = commandLine.trim().split(/\s+/u);
	const runner = /^(?:npm|pnpm|yarn|bun)$/u.test(words[0] ?? "");
	const script = runner ? (words[1] === "run" || words[1] === "run-script" ? words[2] : words[1]) : undefined;

	if (script !== undefined && cwd !== undefined && depth < 4) {
		const command = (await scriptsNear(cwd))[script];

		if (command !== undefined) {
			const guess = lifecycleOfScript(script, command);

			return guess.lifecycle === "service" ? guess : classify(command, cwd, depth + 1);
		}
	}

	const file = /^(?:node|tsx|ts-node)$/u.test(words[0] ?? "") ? words.slice(1).find((word) => !word.startsWith("-")) : undefined;
	const source = file === undefined || cwd === undefined ? undefined : await readText(file.startsWith("/") ? vscode.Uri.file(file) : vscode.Uri.joinPath(cwd, file));

	return source === undefined ? lifecycleOfScript("", commandLine) : lifecycleOfSource(source);
}

export function activate(context: vscode.ExtensionContext): void {
	const item = vscode.window.createStatusBarItem("running", vscode.StatusBarAlignment.Left, 50);
	const live = new Set<Run>();
	const ended: Run[] = [];

	item.name = "Running";
	item.command = "running.show";

	const refresh = (): void => {
		const shown = [...live].filter((run) => run.counted);

		if (shown.length === 0) {
			item.hide();

			return;
		}

		item.text = `$(play) ${shown.length} running`;
		item.tooltip = shown.map((run) => `${run.title} — ${run.kind}, ${run.where}, ${since(Date.now() - run.startedAt)}`).join("\n");
		item.show();
	};

	const start = (run: Omit<Run, "startedAt" | "state" | "stopping">): Run => {
		const started: Run = { ...run, "startedAt": Date.now(), "state": "running", "stopping": false };

		live.add(started);

		if (!started.counted) {
			setTimeout(() => {
				if (started.state === "running") {
					started.counted = true;
					refresh();
				}
			}, COUNTS_AFTER_MS);
		}

		refresh();

		return started;
	};

	const showTerminal = (run: Run) => (choice: string | undefined): void => {
		if (choice === "Show Terminal") {
			run.terminal?.show();
		}
	};

	/** It ended: with an exit code (130 is interrupted, as a shell reports Ctrl-C), or none known. */
	const end = (run: Run | undefined, exitCode: number | undefined): void => {
		if (run === undefined || run.state !== "running") {
			return;
		}

		live.delete(run);
		run.endedAt = Date.now();
		run.exitCode = exitCode;
		run.state = run.stopping || exitCode === 130 ? "stopped" : exitCode === undefined ? "ended" : exitCode === 0 ? "exited" : "failed";
		refresh();

		if (!run.counted) {
			return;
		}

		ended.unshift(run);
		ended.length = Math.min(ended.length, KEEP_ENDED);

		const after = since(run.endedAt - run.startedAt);
		const actions = run.terminal === undefined ? [] : ["Show Terminal"];

		if (run.state === "exited" && run.kind === "task") {
			vscode.window.setStatusBarMessage(`$(check) ${run.title} finished in ${after}`, 5000);
		} else if (run.state === "failed") {
			void vscode.window.showErrorMessage(run.kind === "task" ? `${run.title} failed (exit ${exitCode}) after ${after}` : `${run.title} stopped unexpectedly (exit ${exitCode}) after ${after}`, ...actions).then(showTerminal(run));
		} else if (run.state === "exited" && run.kind === "service") {
			void vscode.window.showWarningMessage(`${run.title} stopped by itself after ${after}`, ...actions).then(showTerminal(run));
		}
	};

	// ── Commands in a terminal ────────────────────────────────────────────────────────────────────────────────────
	const executions = new Map<vscode.TerminalShellExecution, Run>();

	context.subscriptions.push(
		vscode.window.onDidStartTerminalShellExecution((event) => {
			const title = event.execution.commandLine.value.trim();

			if (title === "") {
				return;
			}

			const terminal = event.terminal;
			const run = start({
				"title": title,
				"kind": "task",
				"where": "terminal " + terminal.name,
				"counted": PROGRAMS.has(title.split(/\s+/u)[0] ?? ""),
				"terminal": terminal,
				"stop": () => { terminal.sendText("\x03", false); } // Ctrl-C, as you'd stop it yourself
			});

			executions.set(event.execution, run);
			void classify(title, event.execution.cwd).then((guess) => {
				run.kind = guess.lifecycle;
				refresh();
			}, () => undefined);
		}),
		vscode.window.onDidEndTerminalShellExecution((event) => {
			end(executions.get(event.execution), event.exitCode);
			executions.delete(event.execution);
		}),
		// A closed terminal stops what it was running.
		vscode.window.onDidCloseTerminal((terminal) => {
			for (const [execution, run] of executions) {
				if (run.terminal === terminal) {
					run.stopping = true;
					end(run, undefined);
					executions.delete(execution);
				}
			}
		})
	);

	// ── Debug sessions ────────────────────────────────────────────────────────────────────────────────────────────
	const sessions = new Map<string, Run>();
	// A child session, or one a terminal command or a dev server started for itself (the terminal shows those).
	const standsAlone = (session: vscode.DebugSession): boolean => session.parentSession === undefined && session.configuration["__startedBy"] !== "terminal" && session.configuration["__prodId"] === undefined;

	context.subscriptions.push(
		vscode.debug.onDidStartDebugSession((session) => {
			if (!standsAlone(session)) {
				return;
			}

			const program = typeof session.configuration["program"] === "string" ? vscode.workspace.asRelativePath(session.configuration["program"]) : undefined;
			const run = start({ "title": program === undefined ? session.name : `${session.name} — ${program}`, "kind": "task", "where": "Run and Debug", "counted": true, "stop": () => { void vscode.debug.stopDebugging(session); } });

			sessions.set(session.id, run);
		}),
		vscode.debug.onDidTerminateDebugSession((session) => {
			end(sessions.get(session.id), undefined);
			sessions.delete(session.id);
		})
	);

	// ── Tasks ─────────────────────────────────────────────────────────────────────────────────────────────────────
	const tasks = new Map<vscode.TaskExecution, Run>();

	context.subscriptions.push(
		vscode.tasks.onDidStartTaskProcess((event) => {
			const { execution } = event;

			tasks.set(execution, start({ "title": execution.task.name, "kind": execution.task.isBackground ? "service" : "task", "where": "task", "counted": true, "stop": () => { execution.terminate(); } }));
		}),
		vscode.tasks.onDidEndTaskProcess((event) => {
			end(tasks.get(event.execution), event.exitCode);
			tasks.delete(event.execution);
		})
	);

	// ── The list ──────────────────────────────────────────────────────────────────────────────────────────────────
	context.subscriptions.push(item, vscode.commands.registerCommand("running.show", async () => {
		type Pick = vscode.QuickPickItem & { "run"?: Run };
		const running = [...live].filter((run) => run.counted).sort((a, b) => b.startedAt - a.startedAt);
		const picks: Pick[] = [
			...running.length === 0 ? [] : [{ "label": "Running", "kind": vscode.QuickPickItemKind.Separator }],
			...running.map((run) => ({ "label": `$(${run.kind === "service" ? "server-process" : "play"}) ${run.title}`, "description": since(Date.now() - run.startedAt), "detail": `${run.kind} · ${run.where}`, "run": run })),
			...ended.length === 0 ? [] : [{ "label": "Ended", "kind": vscode.QuickPickItemKind.Separator }],
			...ended.map((run) => ({
				"label": `$(${run.state === "failed" ? "error" : run.state === "stopped" ? "debug-stop" : "check"}) ${run.title}`,
				"description": `${run.state === "exited" || run.state === "failed" ? "exit " + run.exitCode : run.state} · after ${since((run.endedAt ?? run.startedAt) - run.startedAt)} · ${since(Date.now() - (run.endedAt ?? run.startedAt))} ago`,
				"detail": `${run.kind} · ${run.where}`,
				"run": run
			}))
		];

		if (picks.length === 0) {
			void vscode.window.showInformationMessage("Nothing has run yet.");

			return;
		}

		const picked = (await vscode.window.showQuickPick(picks, { "title": "Running", "placeHolder": running.length === 0 ? "Nothing is running" : "Pick a running one to stop it" }))?.run;

		if (picked === undefined) {
			return;
		}

		if (picked.state !== "running") {
			picked.terminal?.show();

			return;
		}

		const choice = await vscode.window.showWarningMessage(`Stop ${picked.title}?`, { "modal": false }, "Stop", ...picked.terminal === undefined ? [] : ["Show Terminal"]);

		if (choice === "Stop") {
			picked.stopping = true;
			picked.stop();
		} else {
			showTerminal(picked)(choice);
		}
	}));
}
