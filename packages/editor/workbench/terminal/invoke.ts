import type { JuvyCommand, RunProcess } from "@brianjenkins94/util/juvy/cli";
import type { Command } from "just-bash/browser";
import type { CommandDefinition, CommandResult, Handler, Implementation } from "./catalog";
import { juvy } from "@brianjenkins94/util/juvy";
import { command, run, subcommands } from "@brianjenkins94/util/juvy/cli";
import { defineCommand } from "just-bash/browser";

export function toCommand(definition: CommandDefinition, implementation?: Implementation): Command {
	return defineCommand(definition.name, async (args, ctx) => {
		const instead = definition.subcommandsNotHere?.[args[0] ?? ""];

		if (definition.notHere !== undefined || instead !== undefined) {
			return { "stdout": "", "stderr": `${definition.name}${instead === undefined ? "" : ` ${args[0]}`}: ${definition.notHere ?? instead}\n`, "exitCode": 127 };
		}

		let [stdout, stderr] = ["", ""];
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
		let result: CommandResult | undefined;
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
					"commands": Object.entries(definition.subcommands).map(([name, subcommand]) => leaf(name, subcommand.summary, subcommand.options, subcommand.stopEarly, (implementation as Record<string, Handler>)[name], subcommand.aliases))
				});

		const numbered = definition.subcommands?.[args[0] ?? ""]?.numberIs;
		const short = numbered === undefined ? undefined : (definition.subcommands?.[args[0]]?.options?.[numbered] as { "short"?: string } | undefined)?.short;
		const argv = short === undefined ? args : args.flatMap((arg, at) => (at > 0 && /^-\d+$/u.test(arg) ? [`-${short}`, arg.slice(1)] : [arg]));

		await run(app, { "argv": argv, "exit": false, "process": proc });

		const exitCode = Number(proc.exitCode ?? 0);

		if (result === undefined && exitCode !== 0 && stderr !== "" && !stderr.startsWith("error:")) {
			stderr = `${definition.name}: ${stderr}`;
		}

		return result === undefined ? { "stdout": stdout, "stderr": stderr, "exitCode": exitCode } : { "stdout": stdout + result.stdout, "stderr": stderr + result.stderr, "exitCode": result.exitCode };
	});
}
