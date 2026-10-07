/**
 * The shell's run picker, from VS Code's tasks: the shell asks for what there is to run (`tasks.list` — the running
 * extension's package.json scripts, and any task the workspace defines) and runs one (`tasks.run`). The bridge's part is
 * only the crossing: tasks are VS Code's, and this asks VS Code for them.
 */
import * as vscode from "vscode";
import { createRpcClient, serve } from "@brianjenkins94/hub";
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

/** Where a file's app is (RUNNING.md, step 4: an app's code runs in its page, its dev server a run): the folder of the
 *  nearest `index.html` up from it, in its own package (the search stops at a `package.json`) — when the page loads the
 *  file, or the file is a component (`.jsx`, `.tsx`) or a page's code (it uses `react-dom` or `document`). A file that's
 *  none of those is a program. */
export async function appRootOf(path: string): Promise<string | undefined> {
	const read = async (file: string): Promise<string | undefined> => Promise.resolve(vscode.workspace.fs.readFile(vscode.Uri.file(file))).then((bytes) => new TextDecoder().decode(bytes), () => undefined);

	for (let dir = path.slice(0, path.lastIndexOf("/")); dir.startsWith("/workspace"); dir = dir.slice(0, dir.lastIndexOf("/"))) {
		const html = await read(`${dir}/index.html`);

		if (html === undefined) {
			// A package with no page: its files are programs (a page further up is another package's).
			if (await read(`${dir}/package.json`) !== undefined) {
				return undefined;
			}

			continue;
		}

		const loaded = [...html.matchAll(/<script\s(?:[^>]*\s)?src\s*=\s*["']([^"']+)["']/giu)].map(([, src]) => `${dir}/${src!.replace(/^\.\//u, "")}`);
		const source = await read(path) ?? "";

		return loaded.includes(path) || /\.[jt]sx$/u.test(path) || /\breact-dom\b|\bdocument\./u.test(source) ? dir : undefined;
	}

	return undefined;
}

/** Run the app at `root`: its `dev` script, as a task (its dev server's output in the task's terminal, its preview
 *  opened as `npm run dev` opens it) — or, already running, its preview shown again. */
export async function runApp(root: string): Promise<void> {
	const running = await createRpcClient(podHub).request("runs.list", undefined, { "timeoutMs": 5000 }).then((list) => (list as { "state": string; "kind": string; "cwd": string; "port"?: number }[]).find((run) => run.state === "running" && run.kind === "service" && run.cwd === root && run.port !== undefined), () => undefined);

	if (running !== undefined) {
		podHub.publish("preview.open", { "port": running.port });

		return;
	}

	const task = (await vscode.tasks.fetchTasks()).find((candidate) => {
		const target = targetOf(candidate);

		return target?.command === "npm run dev" && target.cwd === root;
	});

	if (task === undefined) {
		throw new Error(`${vscode.workspace.asRelativePath(root + "/package.json", false)} has no "dev" script to run the app with (e.g. "dev": "vite")`);
	}

	await vscode.tasks.executeTask(task);
}

export function registerLaunch(context: vscode.ExtensionContext): void {
	const offList = serve(podHub, "tasks.list", async () => (await vscode.tasks.fetchTasks()).flatMap((task) => targetOf(task) ?? []));
	// A task run (RUNNING.md: through the terminal, each `node` in it a run). Already running: its terminal shown, not a
	// second copy. One that can't start says why, in the workbench.
	const offRun = serve(podHub, "tasks.run", async (args) => {
		const { id } = (args ?? {}) as { "id"?: unknown };

		try {
			const task = (await vscode.tasks.fetchTasks()).find((candidate) => idOf(candidate) === id);

			if (task === undefined) {
				throw new Error("it's no longer one of the workspace's tasks");
			}

			if (vscode.tasks.taskExecutions.some((execution) => idOf(execution.task) === id)) {
				vscode.window.terminals.find((terminal) => terminal.name.includes(task.name))?.show();

				return true;
			}

			await vscode.tasks.executeTask(task);

			return true;
		} catch (error) {
			void vscode.window.showErrorMessage(`Couldn't run the task: ${error instanceof Error ? error.message : String(error)}`);

			throw error;
		}
	});
	context.subscriptions.push({ "dispose": () => { offList(); offRun(); } });
}
