/**
 * The terminal's `history`: the lines typed at this terminal (the ones ↑ walks back through), numbered as bash numbers
 * them — `history 5` the last five. just-bash runs each command line in a fresh shell, so its own `history` has nothing
 * to show; the terminal keeps the lines (../../index.ts).
 */
import type { Command } from "just-bash/browser";
import type { CommandHost } from "../../catalog";
import { defineCommand } from "just-bash/browser";

export function create({ history }: CommandHost): Command {
	return defineCommand("history", async (args) => {
		const lines = history();
		const count = /^\d+$/u.test(args[0] ?? "") ? Number(args[0]) : lines.length;
		const first = Math.max(0, lines.length - count);

		return { "stdout": lines.slice(first).map((line, index) => `${String(first + index + 1).padStart(5)}  ${line}\n`).join(""), "stderr": "", "exitCode": 0 };
	});
}
