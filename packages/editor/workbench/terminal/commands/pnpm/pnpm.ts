/**
 * The terminal's `pnpm`: this shell's npm (../npm), in pnpm's words — a bare `pnpm` installs, `pnpm add` adds, `pnpm dlx`
 * runs a command, and a word pnpm doesn't know as its own is a script's name (`pnpm dev`), as pnpm reads it. npm's own
 * definition and handlers, named pnpm, so its messages and its `--help` say pnpm.
 */
import type { CommandHost, Handler } from "../../catalog";
import { toCommand } from "../../invoke";
import npm from "../npm/command";
import { handlers } from "../npm/npm";

/** npm's own subcommands and their aliases: any other word is a script's name. */
const OWN = new Set(Object.entries(npm.subcommands).flatMap(([name, subcommand]) => [name, ...("aliases" in subcommand ? subcommand.aliases : [])]));

/** pnpm's (or yarn's) words as npm's. */
export function asNpm(words: string[]): string[] {
	const [first, ...rest] = words;

	if (first === undefined) {
		return ["install"];
	}

	if (first === "dlx") {
		return ["exec", ...rest];
	}

	return first.startsWith("-") || OWN.has(first) ? words : ["run", ...words];
}

/** The npm `name` (pnpm, yarn) speaks for. */
export function speaking(name: string, { session, api }: CommandHost): Handler {
	const npmAs = toCommand({ ...npm, "name": name }, handlers(name, session, api));

	return async (config, ctx) => {
		if (config.get("version") === true) {
			return { "stdout": `this shell's ${name} is its npm (10.0.0)\n`, "stderr": "", "exitCode": 0 };
		}

		return npmAs.execute(asNpm(config.get("words") as string[]), ctx);
	};
}

export function create(host: CommandHost): Handler {
	return speaking("pnpm", host);
}
