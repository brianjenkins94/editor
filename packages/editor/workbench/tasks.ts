/**
 * Every package.json script is a task (RUNNING.md, *The model*): in VS Code's Run Task and in the shell's Run menu
 * (shell/run-menu.tsx), each run by the workspace's terminal in a terminal of its own, ending when the script does and with its
 * exit code. `npm run` there is what runs it, so a dev server's a service like any other (workbench/runs.ts).
 *
 * `tasks.list`: each script, and whether it's up already. `tasks.run`: a script, unless it's a service that's up: then its
 * preview's shown, rather than a second copy started. `tasks.runFile`: the file in sight (extensions/tsval/run-file.ts).
 */
import type { Hub } from "@brianjenkins94/hub";
import type { Logger } from "@brianjenkins94/util/logger";
import type * as vscodeApi from "vscode";
import type { NodeRunner } from "./node-runner";
import { serve } from "@brianjenkins94/hub";
import { createBashProcess } from "./terminal";

/** Where the terminal says what it's running, and how that ended (terminal/integration.ts). */
const EXECUTED = "\u001B]633;C\u0007";
const FINISHED = /\u001B\]633;D;(?<code>\d+)\u0007/u;

interface Script { "name": string; "folder": string; "line": string }

export function installTasks(vscode: typeof vscodeApi, runner: NodeRunner, hub: Hub, log: Logger): void {
	const scripts = async (): Promise<Script[]> => {
		const manifests = await vscode.workspace.findFiles("**/package.json", "**/node_modules/**");
		const each = await Promise.all(manifests.map(async (uri) => {
			const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
			const declared = (JSON.parse(text) as { "scripts"?: Record<string, string> }).scripts ?? {};
			const folder = uri.path.slice(0, uri.path.lastIndexOf("/"));

			return Object.entries(declared).map(([name, line]) => ({ "name": name, "folder": folder, "line": line }));
		}).map(async (reading) => reading.catch(() => [])));

		return each.flat().toSorted((one, other) => one.folder.localeCompare(other.folder) || one.name.localeCompare(other.name));
	};

	const labelOf = ({ name, folder }: Script): string => {
		const relative = vscode.workspace.asRelativePath(folder, false);

		return relative === folder || relative === ""
			? name
			: `${relative}: ${name}`;
	};

	// Its service: asked for by its name, or by what it runs (`vite`, typed in a terminal, for a script that's `vite`).
	const serviceOf = ({ name, folder, line }: Script): number | undefined => runner.runs.runningService((run) => run.cwd === folder && (run.title === `npm run ${name}` || run.title === line.split(" ")[0]))?.port;

	/** A script, as a task: the workspace's terminal running it, what it says shown from where it starts, and over when it is. */
	const taskOf = (script: Script): vscodeApi.Task => new vscode.Task({ "type": "run", "script": script.name, "folder": script.folder }, vscode.TaskScope.Workspace, labelOf(script), "run", new vscode.CustomExecution(async () => {
		const written = new vscode.EventEmitter<string>();
		const closed = new vscode.EventEmitter<number>();
		let started = false;
		const shell = createBashProcess(vscode, runner, hub, (data) => {
			const executed = data.indexOf(EXECUTED);

			if (!started && executed !== -1) {
				started = true;
			}

			if (started) {
				const finished = FINISHED.exec(data);

				written.fire((executed === -1
					? data
					: data.slice(executed + EXECUTED.length)).replace(FINISHED, ""));

				if (finished !== null) {
					closed.fire(Number(finished.groups?.["code"]));
				}
			}
		}, script.folder);

		return Promise.resolve({
			"onDidWrite": written.event,
			"onDidClose": closed.event,
			"open": () => {
				shell.start();
				shell.input(`npm run ${script.name}\r`);
			},
			"close": () => {
				shell.shutdown();
			},
			"handleInput": (data: string) => {
				shell.input(data);
			}
		});
	}));

	vscode.tasks.registerTaskProvider("run", {
		"provideTasks": async () => log.span("editor.workbench.tasks.provide", {}, async (span) => {
			const found = await scripts();

			span.end({ "count": found.length });

			return found.map(taskOf);
		}),
		"resolveTask": (task) => task
	});

	serve(hub, "tasks.list", async () => (await scripts()).map((script) => ({
		"name": script.name,
		"folder": script.folder,
		"label": labelOf(script),
		"line": script.line,
		"port": serviceOf(script)
	})));
	serve(hub, "tasks.run", async (args) => {
		const { name, folder } = args as { "name": string; "folder": string };

		return log.span("editor.workbench.tasks.run", { "op": name, "path": folder }, async (span) => {
			const script = (await scripts()).find((each) => each.name === name && each.folder === folder);

			if (script === undefined) {
				throw new Error(`no script ${name} in ${folder}`);
			}

			const port = serviceOf(script);

			if (port !== undefined) {
				hub.publish("preview.show", { "port": port });
				span.end({ "shown": port });

				return { "shown": port };
			}

			await vscode.tasks.executeTask(taskOf(script));

			return { "started": true };
		});
	});
	serve(hub, "tasks.runFile", async () => {
		await vscode.commands.executeCommand("editor.debugFile");

		return {};
	});
}
