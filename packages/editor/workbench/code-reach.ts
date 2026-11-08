/**
 * What a way in reaches: `code.reach` { target } answers it for a way in's key (`hub request|code.problems`) or its id
 * (`code.problems`, `installCodeProblems`): History's `history.reach` (extensions/history/reach.ts), what History: What a
 * Way In Reaches… shows. Its reader: agents' `code_reach`.
 */
import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import { serve } from "@brianjenkins94/hub";
import { historyAsker } from "./decisions";

/** How often History is asked while it hasn't read the program (2 s apart: within code_reach's two minutes). */
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
