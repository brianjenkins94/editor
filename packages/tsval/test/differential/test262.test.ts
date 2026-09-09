/**
 * The checked-in test262 sample (vendor/test262-sample, 1-in-25 of the policy-eligible language tests)
 * as an always-on regression corpus. Every test must pass, be inconclusive (Node fails it too), or be
 * a known gap (runs as `todo`). Run the full pinned corpus with `npm run test262:report`.
 */
import { test, after } from "node:test";
import assert from "node:assert";
import { SAMPLE_ROOT, hasCorpus, loadTest262 } from "./test262-corpus.ts";
import { runTest262 } from "./test262-run.ts";
import { knownGap } from "./test262-gaps.ts";

const tally = { pass: 0, todo: 0, skipped: 0, inconclusive: 0, total: 0 };

if (!hasCorpus(SAMPLE_ROOT)) {
	test("test262 sample is present", () => assert.fail("vendor/test262-sample is missing — run `npm run test262:fetch && npm run test262:sample`"));
}

for (const t of loadTest262(SAMPLE_ROOT)) {
	tally.total++;
	const gap = knownGap(t.id);
	test(`test262 ${t.id}`, gap === undefined ? {} : { todo: gap }, async () => {
		const outcome = await runTest262(SAMPLE_ROOT, t);
		if (outcome.kind === "skipped") tally.skipped++;
		else if (outcome.kind === "control-failed") tally.inconclusive++;
		else if (gap !== undefined) {
			tally.todo++; // counted whether or not it (still) fails — node:test reports a passing todo
			if (outcome.kind === "fail") assert.fail(`${outcome.reason}\n--- ${t.id} ---\n${t.meta.description ?? ""}`);
		} else if (outcome.kind === "fail") assert.fail(`${outcome.reason}\n--- ${t.id} ---\n${t.meta.description ?? ""}`);
		else tally.pass++;
	});
}

after(() => {
	// eslint-disable-next-line no-console
	console.log(`test262 sample: ${tally.total} tests — ${tally.pass} pass, ${tally.todo} known gaps (todo), ${tally.inconclusive} inconclusive (Node fails too), ${tally.skipped} skipped by policy`);
});
