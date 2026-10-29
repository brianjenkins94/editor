/**
 * What a way in reaches: `code.reach` { target } answers it for a way in's key (`hub request|code.problems`) or its id
 * (`code.problems`, `installCodeProblems`) — the feature that owns it, where it's registered, what removing it would free
 * and leave by hand, and everywhere code, tests and docs name it. It's the history extension's reading (`history.reach`:
 * the program as silo reads it, and `silo remove`'s plan, nothing written). Its reader: agents' `code_reach`.
 */
import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import { serve } from "@brianjenkins94/hub";

/** How often, and how far apart, History is asked while it hasn't read the program yet. */
const TRIES = 10;
const TRY_MS = 2000;

export function installCodeReach(vscode: typeof vscodeApi, hub: Hub): void {
	serve(hub, "code.reach", async (args, { signal }) => {
		const { target } = (args ?? {}) as { "target"?: unknown };

		if (typeof target !== "string" || target.trim() === "") {
			throw new TypeError("code.reach takes { target }: a way in's key (`hub request|code.problems`) or its id");
		}

		const ask = async (): Promise<{ "ready"?: boolean } | undefined> => Promise.resolve(vscode.commands.executeCommand<{ "ready"?: boolean } | undefined>("history.reach", target.trim())).catch(() => undefined);
		let answer = await ask();

		// (History reads the program as the project opens: until it has, it says it isn't ready)
		for (let tried = 1; (answer === undefined || answer.ready === false) && tried < TRIES && !signal.aborted; tried += 1) {
			await new Promise((resolve) => {
				setTimeout(resolve, TRY_MS);
			});
			answer = await ask();
		}

		return answer ?? { "ready": false, "error": "the history extension didn't answer" };
	});
}
