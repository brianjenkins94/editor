/**
 * What a way in reaches: `code.reach` { target } answers it for a way in's key (`hub request|code.problems`) or its id
 * (`code.problems`, `installCodeProblems`) — the feature that owns it, where it's registered, what removing it would free
 * and leave by hand, and everywhere code, tests and docs name it. It's the history extension's reading (`history.reach`:
 * the program as silo reads it, and `silo remove`'s plan, nothing written). Its reader: agents' `code_reach`. And
 * `decisions.for` { target }: what's been decided about a file or a name — History's `history.decisions`, the ledger's
 * entries, the manifest's features and the docs' lines naming it (agents' `decisions_for`).
 */
import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import { serve } from "@brianjenkins94/hub";

/** How often, and how far apart, History is asked while it hasn't read the program yet. */
const TRIES = 10;
const TRY_MS = 2000;

export function installCodeReach(vscode: typeof vscodeApi, hub: Hub): void {
	// History's answer to `command`, asked again until it has read the program (as the project opens it says it isn't
	// ready, and before it activates its commands aren't there).
	const asked = async (command: string, target: string, signal: AbortSignal): Promise<{ "ready"?: boolean } | undefined> => {
		const ask = async (): Promise<{ "ready"?: boolean } | undefined> => Promise.resolve(vscode.commands.executeCommand<{ "ready"?: boolean } | undefined>(command, target)).catch(() => undefined);
		let answer = await ask();

		for (let tried = 1; (answer === undefined || answer.ready === false) && tried < TRIES && !signal.aborted; tried += 1) {
			await new Promise((resolve) => {
				setTimeout(resolve, TRY_MS);
			});
			answer = await ask();
		}

		return answer;
	};

	// What's been decided about a file or a name: History's reading of the ledger, the manifest and the docs
	// (`history.decisions`; agents' decisions_for).
	serve(hub, "decisions.for", async (args, { signal }) => {
		const { target } = (args ?? {}) as { "target"?: unknown };

		if (typeof target !== "string" || target.trim() === "") {
			throw new TypeError("decisions.for takes { target }: a file (its path or its name) or a name (an identifier, a feature)");
		}

		return await asked("history.decisions", target.trim(), signal) ?? { "error": "the history extension didn't answer" };
	});

	serve(hub, "code.reach", async (args, { signal }) => {
		const { target } = (args ?? {}) as { "target"?: unknown };

		if (typeof target !== "string" || target.trim() === "") {
			throw new TypeError("code.reach takes { target }: a way in's key (`hub request|code.problems`) or its id");
		}

		return await asked("history.reach", target.trim(), signal) ?? { "ready": false, "error": "the history extension didn't answer" };
	});
}
