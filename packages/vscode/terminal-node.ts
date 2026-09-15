/**
 * The terminal's `node` command — a thin just-bash custom command that resolves the target script against the
 * shell's cwd and hands it to the node runner (node-runner.ts → the node-worker), which runs it through
 * almostnode on the shared zen-fs, off the main thread and observable over the hub. just-bash owns the shell;
 * almostnode is the runtime. `node App.tsx` works because almostnode transpiles TS/JSX.
 */
import type { CustomCommand } from "just-bash/browser";
import type { NodeOutput, NodeRunner } from "./node-runner";

import { defineCommand } from "just-bash/browser";

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
export function createNodeCommand(runner: NodeRunner, writeLive: NodeOutput): CustomCommand {
	return defineCommand("node", async (args, ctx) => {
		const target = args.find((argument) => !argument.startsWith("-"));

		if (target === undefined) {
			return { "stdout": "", "stderr": "usage: node <file>\n", "exitCode": 1 };
		}

		const env = ctx.exportedEnv ?? Object.fromEntries(ctx.env);
		const file = resolvePosix(ctx.cwd, target);

		try {
			// Auto-attach: try to run `node <file>` under the tsval debug adapter (always debug mode) — breakpoints,
			// step-back, capability hard-stops. If the debugger can't attach, fall back to a plain run so the command
			// never breaks. (`npm run dev` → `vite` is a separate command and stays on the almostnode "production"
			// path — a full server can't run under the interpreter.)
			const debugged = await runner.debug(file, ctx.cwd, env, { "onOutput": writeLive, "signal": ctx.signal });

			if (debugged.attached) {
				return { "stdout": "", "stderr": "", "exitCode": debugged.exitCode };
			}

			const { exitCode } = await runner.run(file, ctx.cwd, env, { "onOutput": writeLive, "signal": ctx.signal });

			return { "stdout": "", "stderr": "", "exitCode": exitCode };
		} catch (error) {
			// The worker unreachable — surface it rather than hanging the shell.
			return { "stdout": "", "stderr": `node: ${error instanceof Error ? error.message : String(error)}\n`, "exitCode": 1 };
		}
	});
}
