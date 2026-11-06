/** The terminal's `history`: what ↑ goes back through, as lines. A terminal's own, as a shell's is, and gone with it. */
import type { CommandHost, Handler } from "../../catalog";

export function create({ history }: CommandHost): Handler {
	return (config) => {
		if (config.get("clear") === true) {
			history.clear();

			return Promise.resolve({ "stdout": "", "stderr": "", "exitCode": 0 });
		}

		const count = config.get("count") as string;

		if (count !== "" && !/^\d+$/u.test(count)) {
			return Promise.resolve({ "stdout": "", "stderr": `history: ${count}: numeric argument required\n`, "exitCode": 1 });
		}

		const numbered = history.lines().map((line, at) => `${String(at + 1).padStart(5)}  ${line}\n`);

		return Promise.resolve({ "stdout": (count === "" ? numbered : numbered.slice(-Number(count) || numbered.length)).join(""), "stderr": "", "exitCode": 0 });
	};
}
