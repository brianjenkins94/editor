/**
 * The terminal's `pnpm`: this shell's npm (../npm), in pnpm's words — a bare `pnpm` installs, `pnpm add` adds, `pnpm dlx`
 * runs a command, and a word pnpm doesn't know as its own is a script's name (`pnpm dev`), as pnpm reads it.
 */
import type { Command } from "just-bash/browser";
import type { CommandHost } from "../../catalog";
import { defineCommand } from "just-bash/browser";
import { npm } from "../npm/npm";

const OWN = new Set(["install", "i", "add", "ci", "ls", "list", "run", "run-script", "exec", "start", "stop", "test", "restart"]);

/** pnpm's arguments as npm's. */
export function asNpm(args: string[]): string[] {
	const [first, ...rest] = args;

	if (first === undefined) {
		return ["install"];
	}

	if (first === "dlx") {
		return ["exec", ...rest];
	}

	return first.startsWith("-") || OWN.has(first) ? args : ["run", ...args];
}

export function create({ session }: CommandHost): Command {
	return defineCommand("pnpm", async (args, ctx) => {
		if (args[0] === "-v" || args[0] === "--version") {
			return { "stdout": "this shell's pnpm is its npm (10.0.0)\n", "stderr": "", "exitCode": 0 };
		}

		return npm("pnpm", session, asNpm(args), ctx);
	});
}
