/**
 * The terminal's `kill`: stop runs (runs.ts) by their id, or any unique beginning of it, as `ps` shows them — the same
 * stop as the running list's and the debug toolbar's. Signals (`-9`) are accepted and mean nothing: a run is stopped,
 * however it's asked.
 */
import type { Command } from "just-bash/browser";
import type { CommandHost } from "../../catalog";
import { defineCommand } from "just-bash/browser";

export function create({ runner }: CommandHost): Command {
	return defineCommand("kill", async (args) => {
		const ids = args.filter((argument) => !argument.startsWith("-"));

		if (ids.length === 0) {
			return { "stdout": "", "stderr": "usage: kill <id>… (the ids are ps's)\n", "exitCode": 1 };
		}

		const running = runner.runs.list().filter((run) => run.state === "running");
		const errors: string[] = [];

		for (const id of ids) {
			const matches = running.filter((run) => run.id.startsWith(id));

			if (matches.length === 1) {
				runner.runs.stop(matches[0]!.id);
			} else {
				errors.push(matches.length === 0 ? `kill: ${id}: nothing running by that id (ps lists them)` : `kill: ${id}: more than one run starts with that — give more of the id`);
			}
		}

		return { "stdout": "", "stderr": errors.map((error) => error + "\n").join(""), "exitCode": errors.length === 0 ? 0 : 1 };
	});
}
