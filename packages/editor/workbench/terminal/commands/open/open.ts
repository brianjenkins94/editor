/** The terminal's `open`: as `code` for what's in the workspace (commands/code), and the browser for an address. */
import type { CommandHost, Handler } from "../../catalog";
import { openPaths } from "../code/code";

const ADDRESS = /^[a-z][a-z\d+.-]*:\/\//iu;

export function create({ api }: CommandHost): Handler {
	return async (config, ctx) => {
		const targets = config.get("targets") as string[];

		if (targets.length === 0) {
			return { "stdout": "", "stderr": "open: what? (a file, a folder or an address)\n", "exitCode": 1 };
		}

		for (const address of targets.filter((target) => ADDRESS.test(target))) {
			await api.env.openExternal(api.Uri.parse(address));
		}

		return openPaths(api, targets.filter((target) => !ADDRESS.test(target)), ctx);
	};
}
