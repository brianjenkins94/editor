/**
 * TypeScript compiler test cases as differential inputs: the checked-in sample (vendor/typescript-
 * cases-sample) runs in `npm test`. A mismatch fails unless it is a known gap (`todo`); agreement on
 * a failure ("both threw") is tallied separately from agreement on a value.
 */
import assert from "node:assert";
import { after, test } from "node:test";
import { SAMPLE_ROOT, loadTsCases } from "./ts-cases-corpus.ts";
import { CaseRunner } from "./ts-cases-runner.ts";
import { knownGap } from "./ts-cases-gaps.ts";

const tally = { match: 0, bothThrew: 0, todo: 0, skipped: 0, inconclusive: 0, total: 0 };
const runner = new CaseRunner();

for (const t of loadTsCases(SAMPLE_ROOT)) {
	tally.total++;
	const gap = knownGap(t.id);
	test(`ts-case ${t.id}`, gap === undefined ? {} : { todo: gap }, async () => {
		const outcome = await runner.run(SAMPLE_ROOT, t.id);
		if (outcome.kind === "skipped") tally.skipped++;
		else if (outcome.kind === "inconclusive") tally.inconclusive++;
		else if (gap !== undefined) {
			tally.todo++;
			if (outcome.kind === "mismatch") assert.fail(`${outcome.reason}\n--- ${t.id} ---`);
		} else if (outcome.kind === "mismatch") assert.fail(`${outcome.reason}\n--- ${t.id} ---`);
		else if (outcome.kind === "both-threw") tally.bothThrew++;
		else tally.match++;
	});
}

after(async () => {
	await runner.close();
	if (tally.total === 0) return;
	console.log(`TypeScript cases sample: ${tally.total} cases — ${tally.match} match, ${tally.bothThrew} agree on a failure, ${tally.todo} known gaps (todo), ${tally.inconclusive} inconclusive, ${tally.skipped} skipped by policy`);
});
