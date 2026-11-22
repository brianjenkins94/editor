import type { CommandHost, Handler } from "../../catalog";

export function create({ runner }: CommandHost): Handler {
	return (config) => {
		const ids = config.get("ids") as string[];

		if (ids.length === 0) {
			return Promise.resolve({ "stdout": "", "stderr": "kill: which run? (ps lists them)\n", "exitCode": 1 });
		}

		const running = runner.runs.list().filter((run) => run.state === "running");
		const errors: string[] = [];

		for (const id of ids) {
			const matches = running.filter((run) => run.id.startsWith(id));

			if (matches.length === 1) {
				runner.runs.stop(matches[0].id);
			} else {
				errors.push(matches.length === 0 ? `kill: ${id}: nothing running by that id (ps lists them)` : `kill: ${id}: more than one run starts with that — give more of the id`);
			}
		}

		return Promise.resolve({ "stdout": "", "stderr": errors.map((error) => error + "\n").join(""), "exitCode": errors.length === 0 ? 0 : 1 });
	};
}
