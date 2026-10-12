/** The terminal's `yarn`: this shell's npm (../npm), in yarn's words — the same reading as pnpm's (../pnpm). */
import type { Command } from "just-bash/browser";
import type { CommandHost } from "../../catalog";
import { defineCommand } from "just-bash/browser";
import { npm } from "../npm/npm";
import { asNpm } from "../pnpm/pnpm";

export function create({ session }: CommandHost): Command {
	return defineCommand("yarn", async (args, ctx) => {
		if (args[0] === "-v" || args[0] === "--version") {
			return { "stdout": "this shell's yarn is its npm (10.0.0)\n", "stderr": "", "exitCode": 0 };
		}

		return npm("yarn", session, asNpm(args), ctx);
	});
}
