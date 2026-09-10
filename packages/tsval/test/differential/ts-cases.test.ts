/**
 * TypeScript compiler test cases as differential inputs: the checked-in sample (vendor/typescript-
 * cases-sample) runs in `npm test`. A mismatch fails unless it is a known gap (`todo`); agreement on
 * a failure ("both threw") is tallied separately from agreement on a value.
 */
import assert from "node:assert";
import { after, test } from "node:test";
import { loadTsCases, SAMPLE_ROOT } from "./ts-cases-corpus.ts";
import { knownGap } from "./ts-cases-gaps.ts";
import { CaseRunner } from "./ts-cases-runner.ts";

const tally = { "match": 0, "bothThrew": 0, "todo": 0, "skipped": 0, "inconclusive": 0, "total": 0 };
const runner = new CaseRunner();

for (const testCase of loadTsCases(SAMPLE_ROOT)) {
	tally.total += 1;
	const gap = knownGap(testCase.id);

	test(`ts-case ${testCase.id}`, gap === undefined ? {} : { "todo": gap }, async () => {
		const outcome = await runner.run(SAMPLE_ROOT, testCase.id);

		if (outcome.kind === "skipped") {
			tally.skipped += 1;
		} else if (outcome.kind === "inconclusive") {
			tally.inconclusive += 1;
		} else if (gap !== undefined) {
			tally.todo += 1;
			if (outcome.kind === "mismatch") {
				assert.fail(`${outcome.reason}\n--- ${testCase.id} ---`);
			}
		} else if (outcome.kind === "mismatch") {
			assert.fail(`${outcome.reason}\n--- ${testCase.id} ---`);
		} else if (outcome.kind === "both-threw") {
			tally.bothThrew += 1;
		} else {
			tally.match += 1;
		}
	});
}

after(async () => {
	await runner.close();
	if (tally.total === 0) {
		return;
	}

	console.log(`TypeScript cases sample: ${tally.total} cases — ${tally.match} match, ${tally.bothThrew} agree on a failure, ${tally.todo} known gaps (todo), ${tally.inconclusive} inconclusive, ${tally.skipped} skipped by policy`);
});
