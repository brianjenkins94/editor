/**
 * The terminal's `node` command — a thin just-bash custom command that resolves the target script against the
 * shell's cwd and hands it to the node runner (node-runner.ts → the node-worker), which runs it through
 * almostnode on the shared zen-fs, off the main thread and observable over the hub. just-bash owns the shell;
 * almostnode is the runtime. `node App.tsx` works because almostnode transpiles TS/JSX.
 */
import { defineCommand } from "just-bash/browser";
import type { CustomCommand } from "just-bash/browser";

import type { RunNode } from "./node-runner";

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

/** The `node <file>` command: resolve the script against cwd and run it in the node worker. */
export function createNodeCommand(runNode: RunNode): CustomCommand {
	return defineCommand("node", async (args, ctx) => {
		const target = args.find((argument) => !argument.startsWith("-"));

		if (target === undefined) {
			return { "stdout": "", "stderr": "usage: node <file>\n", "exitCode": 1 };
		}

		const env = ctx.exportedEnv ?? Object.fromEntries(ctx.env);

		try {
			return await runNode(resolvePosix(ctx.cwd, target), ctx.cwd, env);
		} catch (error) {
			// The worker unreachable or the run timed out — surface it rather than hanging the shell.
			return { "stdout": "", "stderr": `node: ${error instanceof Error ? error.message : String(error)}\n`, "exitCode": 1 };
		}
	});
}
