/**
 * The terminal's `node` command — a thin just-bash custom command that resolves the target script against the shell's
 * cwd and runs it as every Run does (RUNNING.md, step 3): in the debugger, its output and stdin this terminal, with the
 * command line's arguments, the shell's directory and its environment. just-bash owns the shell. When the debugger can't
 * take it, it says so and fails (exit 1) — there's no plain-runtime fallback.
 *
 * Node's other forms, as people type them: `-e <code>` runs the code and `-p <expression>` prints it (the debugger
 * runs files, so the code goes in one under `.silo/local/`, which stays out of git, removed after); `-v` asks the runtime
 * itself (`-p process.version`); `--test` and a bare `node` (a REPL) say they aren't here yet rather than misbehave.
 */
import type { Command } from "just-bash/browser";
import type { CommandHost } from "../../catalog";

import { defineCommand } from "just-bash/browser";
import { lifecycleOfSource } from "../../../lifecycle";

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
/** Where `-e` / `-p` code is run from: silo's machine-local folder, out of git (and out of the way). */
const EVAL_DIR = "/workspace/.silo/local/node-eval";

/** How `node`'s arguments ask to be run: a file (and its arguments), code (`-e`, `-p`), or something not here. */
export type NodeInvocation = { "file": string; "args": string[] } | { "code": string; "print": boolean; "args": string[] } | { "unsupported": string };

/** Read `node`'s arguments as node does: options before the file (or the code), the program's own arguments after. */
export function invocationOf(args: string[]): NodeInvocation {
	for (let index = 0; index < args.length; index += 1) {
		const argument = args[index];

		if (argument === "-e" || argument === "--eval" || argument === "-p" || argument === "--print") {
			const code = args[index + 1];

			return code === undefined ? { "unsupported": `node: ${argument} requires an argument` } : { "code": code, "print": argument === "-p" || argument === "--print", "args": args.slice(index + 2) };
		}

		if (argument === "-v" || argument === "--version") {
			return { "code": "process.version", "print": true, "args": [] };
		}

		if (argument === "--test") {
			return { "unsupported": "node: --test isn't here yet — this runtime has no node:test. Run a test file as a program: node <file>" };
		}

		if (!argument.startsWith("-")) {
			return { "file": argument, "args": args.slice(index + 1) };
		}
	}

	return { "unsupported": "node: there's no REPL here yet — `node -e` runs a line of code, `node` with a file runs a program" };
}

export function create({ runner, writeLive, terminal }: CommandHost): Command {
	return defineCommand("node", async (args, ctx) => {
		const invocation = invocationOf(args);

		if ("unsupported" in invocation) {
			// (A bare `node` asked for nothing that failed — there's just no REPL — so it isn't an error.)
			return { "stdout": "", "stderr": invocation.unsupported + "\n", "exitCode": args.length === 0 ? 0 : 1 };
		}

		// Code runs from a file of its own, removed once it's run.
		let scratch: string | undefined;

		if ("code" in invocation) {
			scratch = `${EVAL_DIR}/${crypto.randomUUID().slice(0, 8)}.js`;
			await ctx.fs.mkdir(EVAL_DIR, { "recursive": true });
			await ctx.fs.writeFile(scratch, invocation.print ? `console.log(${invocation.code});\n` : invocation.code + "\n");
		}

		try {
			return await runFile("code" in invocation ? scratch : invocation.file, invocation.args, "code" in invocation ? `node ${args.join(" ")}` : undefined);
		} finally {
			if (scratch !== undefined) {
				await ctx.fs.rm(scratch, { "force": true }).catch(() => undefined);
			}
		}

		async function runFile(target: string, programArgs: string[], title: string | undefined): Promise<{ "stdout": string; "stderr": string; "exitCode": number }> {
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

			// Service or task, by what its source does (lifecycle.ts) — a label for the running list, not how it runs: every run
			// is the debugger's, and one that listens becomes a service. An unreadable file is left to fail as a task.
			const source = await ctx.fs.readFile(file).catch(() => undefined);
			const guess = source === undefined ? undefined : lifecycleOfSource(source);
			const kind = guess?.lifecycle ?? "task";
			// In the running list as it was asked for (`npm run build` runs `node build.ts`). (`npm run` passes the script's
			// name in the environment it runs it with — ctx.env, not the exported one.)
			const event = Object.fromEntries(ctx.env)["npm_lifecycle_event"] ?? env["npm_lifecycle_event"];
			const run = runner.runs.start({ "title": title ?? (event === undefined ? "node " + args.join(" ") : "npm run " + event), "kind": kind, "cwd": ctx.cwd, "origin": { "terminal": terminal }, "entry": file, "runtime": "tsval" }, () => { controller.abort(); });
			const ended = (exitCode: number): { "stdout": string; "stderr": string; "exitCode": number } => {
				run.end(exitCode, controller.signal.aborted);

				return { "stdout": "", "stderr": "", "exitCode": exitCode };
			};

			try {
				// In the debugger, as every Run is — breakpoints, step-back, capability stops — its output here, its stdin from
				// here, the arguments after the file. (`npm run dev` → `vite` is a separate command, the dev server's.)
				const debugged = await runner.debug(file, ctx.cwd, env, { "runId": run.id, "onOutput": writeLive, "signal": controller.signal, "args": programArgs, "onListening": (port) => { run.update({ "kind": "service", "port": port }); } });

				if (debugged.attached) {
					return ended(debugged.exitCode);
				}

				// The debugger couldn't take it: say so, loudly — no plain-runtime fallback (RUNNING.md, *What can't run this
				// way*: a gap is a bug to fix, not a second way to run).
				run.end(1);

				return { "stdout": "", "stderr": `node: couldn't start the debugger for ${target}\n`, "exitCode": 1 };
			} catch (error) {
				// The worker unreachable — surface it rather than hanging the shell.
				run.end(1);

				return { "stdout": "", "stderr": `node: ${error instanceof Error ? error.message : String(error)}\n`, "exitCode": 1 };
			}
		}
	});
}
