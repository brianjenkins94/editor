/**
 * The checked-in test262 sample (vendor/test262-sample, 1-in-25 of the policy-eligible language tests)
 * as an always-on regression corpus. Every test must pass, be inconclusive (Node fails it too), or be
 * a known gap (runs as `todo`). Run the full pinned corpus with `npm run test262:report`.
 */
import assert from "node:assert";
import { after, test } from "node:test";
import { hasCorpus, loadTest262, SAMPLE_ROOT } from "./test262-corpus.ts";
import { knownGap } from "./test262-gaps.ts";
import { runTest262 } from "./test262-run.ts";

const tally = { "pass": 0, "todo": 0, "skipped": 0, "inconclusive": 0, "total": 0 };

if (!hasCorpus(SAMPLE_ROOT)) {
	test("test262 sample is present", () => assert.fail("vendor/test262-sample is missing — run `npm run test262:fetch && npm run test262:sample`"));
}

for (const testCase of loadTest262(SAMPLE_ROOT)) {
	tally.total += 1;
	const gap = knownGap(testCase.id);

	test(`test262 ${testCase.id}`, gap === undefined ? {} : { "todo": gap }, async () => {
		const outcome = await runTest262(SAMPLE_ROOT, testCase);

		if (outcome.kind === "skipped") {
			tally.skipped += 1;
		} else if (outcome.kind === "control-failed") {
			tally.inconclusive += 1;
		} else if (gap !== undefined) {
			tally.todo += 1; // counted whether or not it (still) fails — node:test reports a passing todo
			if (outcome.kind === "fail") {
				assert.fail(`${outcome.reason}\n--- ${testCase.id} ---\n${testCase.meta.description ?? ""}`);
			}
		} else if (outcome.kind === "fail") {
			assert.fail(`${outcome.reason}\n--- ${testCase.id} ---\n${testCase.meta.description ?? ""}`);
		} else {
			tally.pass += 1;
		}
	});
}

after(() => {
	console.log(`test262 sample: ${tally.total} tests — ${tally.pass} pass, ${tally.todo} known gaps (todo), ${tally.inconclusive} inconclusive (Node fails too), ${tally.skipped} skipped by policy`);
});
