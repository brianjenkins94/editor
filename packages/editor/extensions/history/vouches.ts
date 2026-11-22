import type { TestReport } from "@brianjenkins94/editor-api";
import type { Vouch } from "@brianjenkins94/util/silo/select";
import { digest } from "@brianjenkins94/util/silo/graph";
import { testId } from "@brianjenkins94/util/silo/select";

export function reachedBy(files: readonly string[], blob: (file: string) => string | undefined): Record<string, string> | undefined {
	const reached: Record<string, string> = {};

	for (const file of files) {
		const id = blob(file);

		if (id === undefined) {
			return undefined;
		}

		reached[file] = digest(id);
	}

	return reached;
}

export function vouchesOf(file: string, tests: readonly TestReport[], ranOf: (test: TestReport) => string[], blob: (file: string) => string | undefined, made: { "by": string; "at": string }): { "vouches": Vouch[]; "unsure": string[] } {
	const vouches: Vouch[] = [];
	const unsure: string[] = [];

	for (const test of tests.filter((each) => each.outcome === "pass")) {
		const others = ranOf(test).filter((each) => each !== file);
		const held = others.length === 0 ? undefined : reachedBy([file, ...new Set(others)], blob);

		if (held === undefined) {
			unsure.push(testId(file, test.titles));
		} else {
			vouches.push({ "test": testId(file, test.titles), "outcome": "pass", "by": made.by, "at": made.at, "runtime": "tsval", "reached": held });
		}
	}

	return { "vouches": vouches, "unsure": unsure };
}
