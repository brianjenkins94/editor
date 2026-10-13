/** The terminal's `yarn`: this shell's npm (../npm), in yarn's words — read as pnpm's are (../pnpm). */
import type { CommandHost, Handler } from "../../catalog";
import { speaking } from "../pnpm/pnpm";

export function create(host: CommandHost): Handler {
	return speaking("yarn", host);
}
