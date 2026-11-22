import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import { serve } from "@brianjenkins94/hub";
import { historyAsker } from "./decisions";

const TRIES = 55;

export function installCodeReach(vscode: typeof vscodeApi, hub: Hub): void {
	const asked = historyAsker(vscode);

	serve(hub, "code.reach", async (args, { signal }) => {
		const { target } = (args ?? {}) as { "target"?: unknown };

		if (typeof target !== "string" || target.trim() === "") {
			throw new TypeError("code.reach takes { target }: a way in's key (`hub request|code.problems`) or its id");
		}

		return await asked("history.reach", target.trim(), signal, TRIES) ?? { "ready": false, "error": "the history extension didn't answer" };
	});
}
