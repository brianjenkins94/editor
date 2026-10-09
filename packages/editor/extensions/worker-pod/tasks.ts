/**
 * What there is to run, as VS Code tasks: every package.json script in the workspace (each package of a monorepo) is a
 * `run` task — `npm run <name>` in its package's folder — so Run Task lists them, the running list sees them run
 * (`vscode.tasks`), and the run picker and F5 run them the same way. A script that keeps running (a dev server, a
 * watcher — lifecycle.ts) is a background task.
 *
 * It's the bridge's because of how a task runs here: VS Code for the web runs a task only through a pseudoterminal its
 * provider supplies (no shell of its own), and the shell is the core runtime's — so each task's pseudoterminal asks core
 * for a just-bash process that runs its command (terminal.ts's serveTaskTerminals), over the hub.
 */
import type { TaskDefinition } from "vscode";
import { createRpcClient } from "@brianjenkins94/hub";
import * as vscode from "vscode";
import { lifecycleOfScript } from "../../lifecycle";
import { podHub } from "./pod";

/** A `run` task: a command, as typed in a terminal, and where to run it. */
export interface RunTaskDefinition extends TaskDefinition {
	"type": "run";
	"command": string;
	"cwd"?: string;
}

const WORKSPACE = "/workspace";
const rpc = createRpcClient(podHub);

/** A task's terminal: core's just-bash running `command` in `cwd`, its output here, its exit code the task's. */
function taskTerminal(command: string, cwd: string): vscode.Pseudoterminal {
	const write = new vscode.EventEmitter<string>();
	const close = new vscode.EventEmitter<number>();
	const id = crypto.randomUUID();
	const offs: (() => void)[] = [];
	const done = (code: number): void => {
		for (const off of offs.splice(0)) {
			off();
		}

		close.fire(code);
	};

	return {
		"onDidWrite": write.event,
		"onDidClose": close.event,
		"open": () => {
			offs.push(podHub.subscribe(`terminal.out.${id}`, (data) => { write.fire(String(data)); }), podHub.subscribe(`terminal.exit.${id}`, (data) => { done((data as { "code"?: number } | null)?.code ?? 0); }));
			void rpc.request("terminal.run", { "id": id, "command": command, "cwd": cwd }, { "timeoutMs": 10_000, "waitForResponderMs": 10_000 }).catch((error: unknown) => {
				write.fire(`couldn't start ${command}: ${String(error)}\r\n`);
				done(1);
			});
		},
		"handleInput": (data) => { podHub.publish(`terminal.in.${id}`, data); },
		"close": () => { podHub.publish(`terminal.stop.${id}`, {}); }
	};
}

/** A `run` task named `name`: `command` in `cwd`, from `source` ("npm" for a package's script). */
export function runTask(name: string, command: string, cwd: string, source: string, background: boolean): vscode.Task {
	const definition: RunTaskDefinition = { "type": "run", "command": command, "cwd": cwd };
	const task = new vscode.Task(definition, vscode.TaskScope.Workspace, name, source, new vscode.CustomExecution(async () => taskTerminal(command, cwd)));

	task.isBackground = background;

	return task;
}

/** Every package.json script under the workspace (not a dependency's), as a task. */
async function scriptTasks(): Promise<vscode.Task[]> {
	const manifests = await vscode.workspace.findFiles("**/package.json", "**/node_modules/**").then((found) => found, () => [vscode.Uri.file(WORKSPACE + "/package.json")]);
	const tasks: vscode.Task[] = [];

	for (const uri of manifests.filter((manifest) => !manifest.path.includes("/node_modules/"))) {
		try {
			const scripts = (JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))) as { "scripts"?: Record<string, string> }).scripts ?? {};
			const dir = uri.path.replace(/\/package\.json$/u, "") || WORKSPACE;
			const path = dir.replace(/^\/workspace\/?/u, "");

			for (const [script, body] of Object.entries(scripts)) {
				const task = runTask(path === "" ? script : `${script} · ${path}`, `npm run ${script}`, dir, "npm", lifecycleOfScript(script, String(body)).lifecycle === "service");

				task.group = script === "build" ? vscode.TaskGroup.Build : script === "test" ? vscode.TaskGroup.Test : undefined;
				tasks.push(task);
			}
		} catch { /* absent, or not JSON */ }
	}

	return tasks.sort((a, b) => a.name.localeCompare(b.name));
}

export function registerTasks(context: vscode.ExtensionContext): void {
	context.subscriptions.push(vscode.tasks.registerTaskProvider("run", {
		"provideTasks": scriptTasks,
		// A `run` task named in tasks.json: its command, as it says.
		"resolveTask": (task) => {
			const { command, cwd } = task.definition as RunTaskDefinition;

			return typeof command === "string" ? runTask(task.name, command, cwd ?? WORKSPACE, task.source, task.isBackground) : undefined;
		}
	}));
}
