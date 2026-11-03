/** @jsxImportSource preact */
/**
 * A change's problems in the review panel (git-panel.tsx places them on each changed file's row): the problems the change
 * made in it and the ones it fixed, against HEAD — TypeScript's and ESLint's, as `code.problems` compares them
 * (workbench/code-problems.ts), the answer agents' `code_problems` gets. Asked again once the changes settle
 * (`git.changed`), one request at a time: a comparison checks each changed file and its importers twice.
 */
import type { Hub } from "@brianjenkins94/hub";
import { createRpcClient } from "@brianjenkins94/hub";
import { useEffect, useState } from "preact/hooks";

/** A problem as `code.problems` says it: where (HEAD's lines for a cleared one), whose, and what. */
interface Problem { "file": string; "line": number; "column": number; "source": string; "code": string | number | null; "severity": string; "message": string }

/** A changed file's problems: those the change made, and those it fixed. */
export interface FileProblems { "added": Problem[]; "cleared": Problem[] }

/** How long the changes settle before they're compared again. */
const SETTLE_MS = 1500;

/** The problems `added` and `cleared`, by file. */
function byFile(added: Problem[], cleared: Problem[]): Map<string, FileProblems> {
	const files = new Map<string, FileProblems>();
	const of = (file: string): FileProblems => {
		const known = files.get(file) ?? { "added": [], "cleared": [] };

		files.set(file, known);

		return known;
	};

	for (const problem of added) {
		of(problem.file).added.push(problem);
	}

	for (const problem of cleared) {
		of(problem.file).cleared.push(problem);
	}

	return files;
}

/** Each changed file's problems, kept to the changes as they settle. */
export function useChangeProblems(hub: Hub): Map<string, FileProblems> {
	const [problems, setProblems] = useState(new Map<string, FileProblems>());

	useEffect(() => {
		const rpc = createRpcClient(hub);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let asking = false;
		let again = false;
		let gone = false;
		const ask = async (): Promise<void> => {
			if (asking) {
				again = true;

				return;
			}

			asking = true;

			try {
				// (sent once something serves it: a request before then isn't delivered when it does, and would wait out its
				// timeout — the shell starts before the workbench's services)
				const { added, cleared } = await rpc.request("code.problems", {}, { "timeoutMs": 300_000, "waitForResponderMs": 120_000 }) as { "added": Problem[]; "cleared": Problem[] };

				if (!gone) {
					setProblems(byFile(added, cleared));
				}
			} catch {
				// (the workbench not up yet, or too busy to answer: the next change asks again)
			} finally {
				asking = false;

				if (again && !gone) {
					again = false;
					schedule();
				}
			}
		};
		const schedule = (): void => {
			clearTimeout(timer);
			timer = setTimeout(() => {
				void ask();
			}, SETTLE_MS);
		};
		const off = hub.subscribe("git.changed", schedule);

		schedule();

		return () => {
			gone = true;
			clearTimeout(timer);
			off();
		};
	}, [hub]);

	return problems;
}

/** A changed file's row's part: how many problems the change made in it, and how many it fixed, each one's line and
 *  message on hover. Nothing when it made and fixed none. */
export function ProblemCounts({ problems }: { "problems"?: FileProblems }) {
	if (problems === undefined || (problems.added.length === 0 && problems.cleared.length === 0)) {
		return null;
	}

	const listed = (list: Problem[]): string => list.map((problem) => `${String(problem.line)}: ${problem.message} (${problem.source}${problem.code === null ? "" : " " + String(problem.code)})`).join("\n");
	const { added, cleared } = problems;

	return (
		<span class="wa-cluster wa-flex-nowrap wa-gap-2xs">
			{added.length > 0 && <wa-badge variant="danger" appearance="outlined" title={"New with this change:\n" + listed(added)} aria-label={`${String(added.length)} new problems`}>{"+" + String(added.length)}</wa-badge>}

			{cleared.length > 0 && <wa-badge variant="success" appearance="outlined" title={"Fixed by this change (as HEAD had them):\n" + listed(cleared)} aria-label={`${String(cleared.length)} problems fixed`}>{"−" + String(cleared.length)}</wa-badge>}
		</span>
	);
}
