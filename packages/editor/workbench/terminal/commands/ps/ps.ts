/**
 * The terminal's `ps`: the runs (runs.ts) — what the terminals, Run and the tasks started — as a table: a short id (the
 * first characters of the run's, which `kill` takes), its state, task or service, its port, where it was started, and
 * what was run. The running ones by default, as `ps` shows live processes; `-a` adds the ones that ended.
 */
import type { RunInfo } from "../../../../shared/runs";
import type { CommandHost, Handler } from "../../catalog";

/** How much of a run's id `ps` shows and `kill` needs (any unique prefix will do). */
export const SHORT_ID = 8;

const where = (run: RunInfo): string => ("terminal" in run.origin ? `terminal ${run.origin.terminal}` : run.origin.other);

export function create({ runner }: CommandHost): Handler {
	return (config) => {
		const all = config.get("all") as boolean;
		const runs = runner.runs.list().filter((run) => all || run.state === "running");

		if (runs.length === 0) {
			return Promise.resolve({ "stdout": all ? "nothing has run yet\n" : "nothing is running (ps -a lists what ended)\n", "stderr": "", "exitCode": 0 });
		}

		const rows = [["ID", "STATE", "KIND", "PORT", "FROM", "COMMAND"], ...runs.map((run) => [run.id.slice(0, SHORT_ID), run.state + (run.exitCode === undefined || run.state === "running" ? "" : ` (${run.exitCode})`), run.kind, run.port === undefined ? "" : String(run.port), where(run), run.title])];
		const widths = rows[0].map((_, column) => Math.max(...rows.map((row) => row[column].length)));

		return Promise.resolve({ "stdout": rows.map((row) => row.map((cell, column) => (column === row.length - 1 ? cell : cell.padEnd(widths[column]))).join("  ") + "\n").join(""), "stderr": "", "exitCode": 0 });
	};
}
