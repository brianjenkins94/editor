/**
 * Exceptions, on the call (no view: the user, 2026-11-06): the answers people gave at a call in their runs — allowed once,
 * or refused — said in that call's decision (findings.ts), beside what the policy says. An answer is an exception to the
 * policy, recorded in the run's effects (`decided`) so it's on record whether or not a policy grew from it; "allowed always"
 * isn't one here, as it's a rule in the policy now and the decision says so.
 *
 * Read from every user's runs kept in `.silo/runs/`, again as they change.
 */
import type { Effect, RunEnvelope } from "@brianjenkins94/util/silo/evidence";
import { parseRuns } from "@brianjenkins94/util/silo/evidence";
import { SILO_DIR } from "@brianjenkins94/util/silo/layout";
import * as vscode from "vscode";

/** The answers that are exceptions, and how each reads. */
const ANSWERS: Partial<Record<NonNullable<Effect["decided"]>, string>> = { "once": "allowed once", "refused": "refused" };

/** An answer given at a call: how, in how many runs, and the latest. */
interface Answered { "how": string; "runs": number; "last": string }

export interface Exceptions {
	/** What was answered at a call of `capability` on `resource` (the program's own calls), said as a sentence to follow
	 *  the decision's (its full stop first); "" when nothing was. */
	"said": (capability: string, resource: string | undefined) => string;
	/** The runs changed: what's said may have. */
	"onDidChange": vscode.Event<void>;
}

export function readExceptions(context: vscode.ExtensionContext): Exceptions {
	const changed = new vscode.EventEmitter<void>();
	let runs: RunEnvelope[] = [];

	const read = async (): Promise<void> => {
		const files = await vscode.workspace.findFiles(`${SILO_DIR}/runs/*.jsonl`);
		const texts = await Promise.all(files.map(async (file) => Promise.resolve(vscode.workspace.fs.readFile(file)).then((bytes) => new TextDecoder().decode(bytes), () => "")));

		runs = texts.flatMap((text) => parseRuns(text));
		changed.fire();
	};

	const watcher = vscode.workspace.createFileSystemWatcher(`**/${SILO_DIR}/runs/*.jsonl`);

	context.subscriptions.push(changed, watcher, watcher.onDidCreate(read), watcher.onDidChange(read), watcher.onDidDelete(read));
	void read();

	return {
		"said": (capability, resource) => {
			if (resource === undefined) {
				return "";
			}

			const answered = new Map<string, Answered>();

			for (const run of runs) {
				for (const effect of run.effects ?? []) {
					const how = effect.decided === undefined ? undefined : ANSWERS[effect.decided];

					if (how !== undefined && effect.package === undefined && effect.capability === capability && effect.resource === resource) {
						const known = answered.get(how);

						answered.set(how, { "how": how, "runs": (known?.runs ?? 0) + 1, "last": known === undefined || run.endedAt > known.last ? run.endedAt : known.last });
					}
				}
			}

			if (answered.size === 0) {
				return "";
			}

			return `. Answered at the call: ${[...answered.values()].map(({ how, runs: count, last }) => `${how} in ${String(count)} run${count === 1 ? "" : "s"} (last ${last.slice(0, 10)})`).join(", ")}`;
		},
		"onDidChange": changed.event
	};
}
