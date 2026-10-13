/**
 * The terminal's `history`: the lines typed at this terminal (the ones ↑ walks back through), numbered as bash numbers
 * them — `history 5` the last five. just-bash runs each command line in a fresh shell, so its own `history` has nothing
 * to show; the terminal keeps the lines (../../index.ts).
 */
import type { CommandHost, Handler } from "../../catalog";

export function create({ history }: CommandHost): Handler {
	return (config) => {
		const lines = history();
		const count = config.get("count") as string;

		if (count !== "" && !/^\d+$/u.test(count)) {
			return Promise.resolve({ "stdout": "", "stderr": `history: ${count}: numeric argument required\n`, "exitCode": 1 });
		}

		const first = count === "" ? 0 : Math.max(0, lines.length - Number(count));

		return Promise.resolve({ "stdout": lines.slice(first).map((line, index) => `${String(first + index + 1).padStart(5)}  ${line}\n`).join(""), "stderr": "", "exitCode": 0 });
	};
}
