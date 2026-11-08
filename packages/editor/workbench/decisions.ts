/**
 * What's been decided about a file or a name: `decisions.for` { target } — History's `history.decisions`, the ledger's
 * entries and the docs' lines naming it. Its reader: agents' `decisions_for`.
 */
import type { Hub } from "@brianjenkins94/hub";
import type * as vscodeApi from "vscode";
import { serve } from "@brianjenkins94/hub";

/** How often, and how far apart, History is asked while it hasn't activated yet (within decisions_for's minute). */
const TRIES = 25;
const TRY_MS = 2000;

/** History's answer to `command` with `target`, asked again (`tries` times) while it doesn't answer or says it isn't
 *  `ready` (code-reach.ts's `history.reach` too). */
export function historyAsker(vscode: typeof vscodeApi): (command: string, target: string, signal: AbortSignal, tries?: number) => Promise<unknown> {
	// History's answer, asked again until it answers (before it activates its commands aren't there).
	// History activates with TypeScript, which VS Code starts only for an open TypeScript file: with none open, one is
	// opened (not shown).
	let woken: Promise<void> | undefined;
	const wake = async (): Promise<void> => {
		woken ??= (async () => {
			if (!vscode.workspace.textDocuments.some((document) => /^(?:typescript|javascript)(?:react)?$/u.test(document.languageId))) {
				const [file] = await vscode.workspace.findFiles("**/*.{ts,tsx}", "**/node_modules/**", 1);

				if (file !== undefined) {
					await vscode.workspace.openTextDocument(file);
				}
			}
		})().catch(() => { /* no TypeScript to open: History says so */ }).finally(() => {
			woken = undefined;
		});

		return woken;
	};

	const unanswered = (answer: unknown): boolean => answer === undefined || (answer as { "ready"?: unknown }).ready === false;

	return async (command, target, signal, tries = TRIES) => {
		const ask = async (): Promise<unknown> => Promise.resolve(vscode.commands.executeCommand(command, target)).catch(() => undefined);
		let answer = await ask();

		if (unanswered(answer)) {
			await wake();
		}

		for (let tried = 1; unanswered(answer) && tried < tries && !signal.aborted; tried += 1) {
			await new Promise((resolve) => {
				setTimeout(resolve, TRY_MS);
			});
			answer = await ask();
		}

		return answer;
	};
}

export function installDecisions(vscode: typeof vscodeApi, hub: Hub): void {
	const asked = historyAsker(vscode);

	serve(hub, "decisions.for", async (args, { signal }) => {
		const { target } = (args ?? {}) as { "target"?: unknown };

		if (typeof target !== "string" || target.trim() === "") {
			throw new TypeError("decisions.for takes { target }: a file (its path or its name) or a name (an identifier, a feature)");
		}

		return await asked("history.decisions", target.trim(), signal) ?? { "error": "the history extension didn't answer" };
	});
}
