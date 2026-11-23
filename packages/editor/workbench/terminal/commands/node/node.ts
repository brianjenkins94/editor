import type { Juvy } from "@brianjenkins94/util/juvy";
import type { CommandHost, Handler } from "../../catalog";
import type { NodeOutput } from "../../../node-runner";

import { lifecycleOfSource } from "@brianjenkins94/editor-api/lifecycle";

function resolvePosix(base: string, path: string): string {
	const combined = path.startsWith("/") ? path : `${base.endsWith("/") ? base.slice(0, -1) : base}/${path}`;
	const stack: string[] = [];

	for (const part of combined.split("/")) {
		if (part === "..") {
			stack.pop();
		} else if (part !== "" && part !== ".") {
			stack.push(part);
		}
	}

	return `/${stack.join("/")}`;
}

const EVAL_DIR = "/workspace/.silo/local/node-eval";

export type NodeInvocation = ({ "file": string; "args": string[] } | { "code": string; "print": boolean; "args": string[] } | { "tests": string[] }) & { "imports"?: string[] } | { "unsupported": string; "exitCode": number };

export function matchesGlob(pattern: string, path: string): boolean {
	const source = pattern.replace(/^\.\//u, "").replaceAll(/\*\*\/|\*\*|[*?.+^${}()|[\]\\]/gu, (token) => ({ "**/": "(?:[^/]+/)*", "**": ".*", "*": "[^/]*", "?": "[^/]" })[token] ?? `\\${token}`);

	return new RegExp(`^${source}$`, "u").test(path);
}

const isGlob = (arg: string): boolean => /[*?]/u.test(arg);

export function isTestFile(path: string): boolean {
	const parts = path.split("/");
	const name = parts.at(-1) ?? "";

	if (!/\.[cm]?[jt]s$/u.test(name) || parts.some((part) => part === "node_modules" || part.startsWith("."))) {
		return false;
	}

	return /(?:^test\.|^test-|[.\-_]test\.[cm]?[jt]s$)/u.test(name) || parts.slice(0, -1).includes("test");
}

export function invocationOf(config: Juvy): NodeInvocation {
	const program = config.get("program") as string[];
	const imports = config.get("import") as string[];
	const preloads = imports.length === 0 ? {} : { "imports": imports };

	if (config.get("version") === true) {
		return { "code": "process.version", "print": true, "args": [], ...preloads };
	}

	if (config.get("eval") !== "" || config.get("print") !== "") {
		const print = config.get("print") !== "";

		return { "code": config.get(print ? "print" : "eval") as string, "print": print, "args": program, ...preloads };
	}

	if (config.get("test") === true) {
		return { "tests": program, ...preloads };
	}

	if (program.length === 0) {
		return { "unsupported": "node: there's no REPL here yet — `node -e` runs a line of code, `node` with a file runs a program", "exitCode": 0 };
	}

	return { "file": program[0], "args": program.slice(1), ...preloads };
}

export function create({ runner, writeLive, captured, terminal }: CommandHost): Handler {
	return async (config, ctx) => {
		const invocation = invocationOf(config);
		const collected = { "out": "", "err": "" };
		const output: NodeOutput = captured() ? (stream, data) => { collected[stream === "err" ? "err" : "out"] += data; } : writeLive;
		const result = (exitCode: number, stderr = ""): { "stdout": string; "stderr": string; "exitCode": number } => ({ "stdout": collected.out, "stderr": collected.err + stderr, "exitCode": exitCode });

		if ("unsupported" in invocation) {
			return { "stdout": "", "stderr": invocation.unsupported + "\n", "exitCode": invocation.exitCode };
		}

		if ("tests" in invocation) {
			const files = invocation.tests.length === 0
				? await filesUnder(ctx.cwd, isTestFile)
				: (await Promise.all(invocation.tests.map(async (each) => (isGlob(each) ? filesUnder(ctx.cwd, (path) => matchesGlob(each, path)) : [each])))).flat();

			if (files.length === 0) {
				return { "stdout": "", "stderr": `node: no test files under ${ctx.cwd}\n`, "exitCode": 1 };
			}

			let exitCode = 0;

			for (const file of files) {
				output("out", `▶ ${file}\n`);

				const ran = await runFile(file, [], `node --test ${file}`);

				exitCode ||= ran.exitCode;

				if (ctx.signal?.aborted === true) {
					break;
				}
			}

			return result(exitCode);
		}

		let scratch: string | undefined;

		if ("code" in invocation) {
			scratch = `${EVAL_DIR}/${crypto.randomUUID().slice(0, 8)}.js`;
			await ctx.fs.mkdir(EVAL_DIR, { "recursive": true });
			await ctx.fs.writeFile(scratch, invocation.print ? `console.log(${invocation.code});\n` : invocation.code + "\n");
		}

		try {
			const title = "code" in invocation ? `node ${invocation.print ? "-p" : "-e"} ${invocation.code}` : ["node", invocation.file, ...invocation.args].join(" ");

			return await runFile("code" in invocation ? scratch : invocation.file, invocation.args, title);
		} finally {
			if (scratch !== undefined) {
				await ctx.fs.rm(scratch, { "force": true }).catch(() => undefined);
			}
		}

		async function filesUnder(dir: string, keep: (path: string) => boolean): Promise<string[]> {
			const found: string[] = [];
			const walk = async (relative: string): Promise<void> => {
				const names = await ctx.fs.readdir(resolvePosix(dir, relative || ".")).catch((): string[] => []);

				for (const name of names.toSorted()) {
					const path = relative === "" ? name : `${relative}/${name}`;

					if (name === "node_modules" || name.startsWith(".")) {
						continue;
					}

					const stat = await ctx.fs.stat(resolvePosix(dir, path)).catch(() => undefined);

					if (stat?.isDirectory === true) {
						await walk(path);
					} else if (keep(path)) {
						found.push(path);
					}
				}
			};

			await walk("");

			return found;
		}

		async function runFile(target: string, programArgs: string[], title: string): Promise<{ "stdout": string; "stderr": string; "exitCode": number }> {
			const env = ctx.exportedEnv ?? Object.fromEntries(ctx.env);
			const file = resolvePosix(ctx.cwd, target);
			const controller = new AbortController();

			if (ctx.signal !== undefined) {
				if (ctx.signal.aborted) {
					controller.abort();
				} else {
					ctx.signal.addEventListener("abort", () => {
						controller.abort();
					}, { "once": true });
				}
			}

			const source = await ctx.fs.readFile(file).catch(() => undefined);
			const guess = source === undefined ? undefined : lifecycleOfSource(source);
			const kind = guess?.lifecycle ?? "task";
			const event = Object.fromEntries(ctx.env)["npm_lifecycle_event"] ?? env["npm_lifecycle_event"];
			const run = runner.runs.start({ "title": event === undefined ? title : "npm run " + event, "kind": kind, "cwd": ctx.cwd, "origin": { "terminal": terminal }, "entry": file, "runtime": "tsval" }, () => {
				controller.abort();
			});
			const ended = (exitCode: number): { "stdout": string; "stderr": string; "exitCode": number } => {
				run.end(exitCode, controller.signal.aborted);

				return result(exitCode);
			};

			const listening = (port: number): void => {
				run.update({ "kind": "service", "port": port });
			};

			try {
				const debugged = await runner.debug(file, ctx.cwd, env, { "runId": run.id, "onOutput": output, "signal": controller.signal, "args": programArgs, "runtimeArgs": ("imports" in invocation ? invocation.imports ?? [] : []).flatMap((each) => ["--import", each]), "onListening": listening });

				if (debugged.attached) {
					return ended(debugged.exitCode);
				}

				run.end(1);

				return result(1, `node: couldn't start the debugger for ${target}\n`);
			} catch (error) {
				run.end(1);

				return result(1, `node: ${error instanceof Error ? error.message : String(error)}\n`);
			}
		}
	};
}
