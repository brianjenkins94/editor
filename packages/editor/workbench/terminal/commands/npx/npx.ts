/** The terminal's `npx`: npm's `exec` (../npm). */
import type { CommandHost, Handler } from "../../catalog";
import { exec } from "../npm/npm";

export function create({ session }: CommandHost): Handler {
	return async (config, ctx) => exec("npx", session, config.get("command") as string[], ctx);
}
