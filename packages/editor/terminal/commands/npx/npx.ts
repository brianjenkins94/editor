/** The terminal's `npx`: npm's `exec` (../npm). */
import type { Command } from "just-bash/browser";
import type { CommandHost } from "../../catalog";
import { defineCommand } from "just-bash/browser";
import { exec } from "../npm/npm";

export function create({ session }: CommandHost): Command {
	return defineCommand("npx", async (args, ctx) => exec("npx", session, args, ctx));
}
