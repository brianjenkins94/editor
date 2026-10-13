/**
 * A command's definition (command.ts) and implementation as a just-bash command, run through juvy: juvy routes its
 * subcommands, parses its options and arguments by its schema (strictly — an unknown flag is an error, as it is in a real
 * CLI), validates them, renders `--help` and "did you mean", and hands the parsed config to the handler. juvy's `run`
 * writes to and exits through the process it's given — here, one that collects the command's output — so the same juvy
 * that runs a desktop CLI (packages/silo) runs the terminal's commands.
 *
 * Kept out of catalog.ts (which only Vite can read, for its glob), so a command's test can make its command here.
 */
import type { JuvyCommand, RunProcess } from "@brianjenkins94/util/juvy/cli";
import type { Command } from "just-bash/browser";
import type { CommandDefinition, CommandResult, Handler, Implementation } from "./catalog";
import { juvy } from "@brianjenkins94/util/juvy";
import { command, run, subcommands } from "@brianjenkins94/util/juvy/cli";
import { defineCommand } from "just-bash/browser";

/** `definition` with `implementation`, as a just-bash command. A missing command (or subcommand) says what to do
 *  instead: 127 for a command, as a shell's "not found"; 1 for a subcommand. */
export function toCommand(definition: CommandDefinition, implementation: Implementation | undefined): Command {
	return defineCommand(definition.name, async (args, ctx) => {
		if (definition.missing !== undefined) {
			return { "stdout": "", "stderr": `${definition.name}: ${definition.missing}\n`, "exitCode": 127 };
		}

		let [stdout, stderr] = ["", ""];
		// The process juvy runs it on: one that collects what it writes, and doesn't exit.
		const proc: RunProcess = {
			"stdout": {
				"write": (text: string) => {
					stdout += text;
				}
			},
			"stderr": {
				"write": (text: string) => {
					stderr += text;
				}
			},
			"exit": () => undefined
		};
		// What the handler returned, if juvy got as far as calling it.
		let result: CommandResult | undefined;
		// A fresh config for each run: a juvy config keeps what it parsed.
		const leaf = (name: string, summary: string, options: CommandDefinition["options"], stopEarly: boolean | undefined, handler: Handler, aliases?: string[]): JuvyCommand => command({
			"name": name,
			"description": summary,
			...aliases === undefined ? {} : { "aliases": aliases },
			"config": juvy(options ?? {}, { "stopEarly": stopEarly === true }),
			"handler": async (config) => { result = await handler(config, ctx); }
		});
		const app = definition.subcommands === undefined
			? leaf(definition.name, definition.summary, definition.options, definition.stopEarly, implementation as Handler)
			: subcommands({
					"name": definition.name,
					"description": definition.summary,
					"commands": Object.entries(definition.subcommands).map(([name, subcommand]) => leaf(name, subcommand.summary, subcommand.options, subcommand.stopEarly, subcommand.missing === undefined
						? (implementation as Record<string, Handler>)[name]
						: () => Promise.resolve({ "stdout": "", "stderr": `${definition.name} ${name}: ${subcommand.missing}\n`, "exitCode": 1 }), subcommand.aliases))
				});

		await run(app, { "argv": args, "exit": false, "process": proc });

		const exitCode = Number(proc.exitCode ?? 0);

		// juvy's own complaints (an unknown option, a missing value) say whose they are, as a shell's commands do.
		if (result === undefined && exitCode !== 0 && stderr !== "" && !stderr.startsWith("error:")) {
			stderr = `${definition.name}: ${stderr}`;
		}

		return result === undefined ? { "stdout": stdout, "stderr": stderr, "exitCode": exitCode } : { "stdout": stdout + result.stdout, "stderr": stderr + result.stderr, "exitCode": result.exitCode };
	});
}
