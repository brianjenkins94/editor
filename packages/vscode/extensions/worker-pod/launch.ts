/**
 * The shell's run picker, from VS Code's tasks: the shell asks for what there is to run (`tasks.list` — the running
 * extension's package.json scripts, and any task the workspace defines) and runs one (`tasks.run`). The bridge's part is
 * only the crossing: tasks are VS Code's, and this asks VS Code for them.
 */
import * as vscode from "vscode";
import { serve } from "@brianjenkins94/hub";
import { podHub } from "./pod";

/** One thing there is to run, as the shell's picker shows it. */
export interface LaunchTarget {
	/** Picks it back out (`tasks.run`): its source and name. */
	"id": string;
	"name": string;
	/** Its package's folder relative to the workspace ("." for the root), when it's a package's script. */
	"package"?: string;
	/** The command it runs (`npm run dev`), and where. */
	"command": string;
	"cwd": string;
	/** Keeps running until stopped (a background task: a dev server, a watcher), or runs to completion. */
	"lifecycle": "service" | "task";
}

const idOf = (task: vscode.Task): string => `${task.source}:${task.name}`;

/** A task as the picker shows it: a `run` task's command (tasks.ts), or a shell task's. */
function targetOf(task: vscode.Task): LaunchTarget | undefined {
	const { command, cwd } = task.definition as { "command"?: unknown; "cwd"?: unknown };
	const shell = task.execution instanceof vscode.ShellExecution ? task.execution : undefined;
	const line = typeof command === "string" ? command : shell?.commandLine;

	if (line === undefined || line === "") {
		return undefined;
	}

	const where = typeof cwd === "string" ? cwd : shell?.options?.cwd ?? "/workspace";
	const path = where.replace(/^\/workspace\/?/u, "");

	return { "id": idOf(task), "name": task.name, "package": task.source === "npm" ? path || "." : undefined, "command": line, "cwd": where, "lifecycle": task.isBackground ? "service" : "task" };
}

export function registerLaunch(context: vscode.ExtensionContext): void {
	const offList = serve(podHub, "tasks.list", async () => (await vscode.tasks.fetchTasks()).flatMap((task) => targetOf(task) ?? []));
	const offRun = serve(podHub, "tasks.run", async (args) => {
		const { id } = (args ?? {}) as { "id"?: unknown };
		const task = (await vscode.tasks.fetchTasks()).find((candidate) => idOf(candidate) === id);

		if (task === undefined) {
			return false;
		}

		await vscode.tasks.executeTask(task);

		return true;
	});
	context.subscriptions.push({ "dispose": () => { offList(); offRun(); } });
}
