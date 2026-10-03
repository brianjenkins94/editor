/**
 * The terminal's `node` command — a thin just-bash custom command that resolves the target script against the
 * shell's cwd and hands it to the node runner (node-runner.ts → the node-worker), which runs it through
 * almostnode on the shared zen-fs, off the main thread and observable over the hub. just-bash owns the shell;
 * almostnode is the runtime. `node App.tsx` works because almostnode transpiles TS/JSX.
 */
import type { CustomCommand } from "just-bash/browser";
import type { NodeOutput, NodeRunner } from "./node-runner";

import { defineCommand } from "just-bash/browser";
import { lifecycleOfSource } from "./lifecycle";

/** POSIX resolve of `path` against `base` (collapsing `.`/`..`). */
function resolvePosix(base: string, path: string): string {
	const combined = path.startsWith("/") ? path : `${base.endsWith("/") ? base.slice(0, -1) : base}/${path}`;
	const stack: string[] = [];

	for (const part of combined.split("/")) {
		if (part === "" || part === ".") {
			continue;
		}

		if (part === "..") {
			stack.pop();
		} else {
			stack.push(part);
		}
	}

	return `/${stack.join("/")}`;
}

/**
 * The `node <file>` command: resolve the script against cwd and run it in the node worker, STREAMING its output
 * straight to the terminal (`writeLive`) as it's produced rather than buffering it into the returned stdout —
 * so a long-running or interactive process shows output live. It therefore returns empty stdout (already
 * written); a consequence is that a streamed `node …` doesn't feed a shell pipe/redirect. `ctx.signal` is the
 * shell's Ctrl-C, forwarded to the runner so the worker is killed.
 */
export function createNodeCommand(runner: NodeRunner, writeLive: NodeOutput, terminal: number): CustomCommand {
	return defineCommand("node", async (args, ctx) => {
		const target = args.find((argument) => !argument.startsWith("-"));

		if (target === undefined) {
			return { "stdout": "", "stderr": "usage: node <file>\n", "exitCode": 1 };
		}

		const env = ctx.exportedEnv ?? Object.fromEntries(ctx.env);
		const file = resolvePosix(ctx.cwd, target);
		// One way to stop it, whoever asks: the shell's Ctrl-C (or the terminal closing), the running list, the debug Stop.
		const controller = new AbortController();

		if (ctx.signal !== undefined) {
			if (ctx.signal.aborted) {
				controller.abort();
			} else {
				ctx.signal.addEventListener("abort", () => { controller.abort(); }, { "once": true });
			}
		}

		// Service or task, by what its source does (lifecycle.ts): a task runs under the debugger, a service — which needs
		// an event loop the debugger doesn't have — under the real runtime. An unreadable file is left to fail as a task.
		const source = await ctx.fs.readFile(file).catch(() => undefined);
		const guess = source === undefined ? undefined : lifecycleOfSource(source);
		const kind = guess?.lifecycle ?? "task";
		// In the running list as it was asked for (`npm run build` runs `node build.ts`). (`npm run` passes the script's
		// name in the environment it runs it with — ctx.env, not the exported one.)
		const event = Object.fromEntries(ctx.env)["npm_lifecycle_event"] ?? env["npm_lifecycle_event"];
		const run = runner.runs.start({ "title": event === undefined ? "node " + args.join(" ") : "npm run " + event, "kind": kind, "cwd": ctx.cwd, "origin": { "terminal": terminal }, "entry": file, "runtime": kind === "task" ? "tsval" : "almostnode" }, () => { controller.abort(); });
		const ended = (exitCode: number): { "stdout": string; "stderr": string; "exitCode": number } => {
			run.end(exitCode, controller.signal.aborted);

			return { "stdout": "", "stderr": "", "exitCode": exitCode };
		};

		try {
			// Auto-attach a task: run it under the tsval debug adapter (always debug mode) — breakpoints, step-back,
			// capability hard-stops. If the debugger can't attach, fall back to a plain run so the command never breaks.
			// (`npm run dev` → `vite` is a separate command and stays on the almostnode "production" path.)
			if (kind === "task") {
				const debugged = await runner.debug(file, ctx.cwd, env, { "runId": run.id, "onOutput": writeLive, "signal": controller.signal });

				if (debugged.attached) {
					return ended(debugged.exitCode);
				}
			}

			// A service, or tsval declined → run on the almostnode "production" path. Present it as a production debug session too
			// (Run and Debug controller + Debug Console), same as the vite preview — so this path isn't a bare
			// process. The debug Stop button and the shell's Ctrl-C both abort the run via one combined signal.
			run.update({ "runtime": "almostnode" });

			const sessionId = runner.startProductionSession(`node ${target}`, undefined, undefined, run.id);
			const offStop = runner.onProductionStop(sessionId, () => { controller.abort(); });

			try {
				const { exitCode } = await runner.run(file, ctx.cwd, env, {
					"runId": run.id,
					"onOutput": (stream, data) => { writeLive(stream, data); runner.emitProductionOutput(sessionId, stream, data); },
					"signal": controller.signal,
					// It listens: a service, whatever it was taken for — with its port.
					"onListening": (port) => { run.update({ "kind": "service", "port": port }); }
				});

				return ended(exitCode);
			} finally {
				offStop();
				runner.endProductionSession(sessionId);
			}
		} catch (error) {
			// The worker unreachable — surface it rather than hanging the shell.
			run.end(1);

			return { "stdout": "", "stderr": `node: ${error instanceof Error ? error.message : String(error)}\n`, "exitCode": 1 };
		}
	});
}
