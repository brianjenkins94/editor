/**
 * Run the ts-evaluator corpus through the differential oracle.
 *
 * Every program must match Node, be a KNOWN_GAP (runs as `todo`: reported, never silently passing,
 * visible the moment it starts to pass), or be OUT_OF_SCOPE by policy (skipped with its reason; an
 * out-of-scope program is additionally checked to fail *loudly* in tsval, never silently). A program
 * where *both* sides throw counts as a pass but is tallied separately: agreement on failure is weaker
 * evidence than agreement on a value.
 */
import { test, after } from "node:test";
import assert from "node:assert";
import { classifyDifferential, runTsval } from "./harness.ts";
import { loadCorpus } from "./ts-evaluator-corpus.ts";
import { KNOWN_GAPS, OUT_OF_SCOPE } from "./ts-evaluator-gaps.ts";
import { TsvalInternalError } from "../../src/errors.ts";

const corpus = loadCorpus();
const tally = { match: 0, bothThrew: 0, todo: 0, outOfScope: 0 };

for (const program of corpus) {
	const title = `ts-evaluator ${program.id}: ${program.name}`;
	const outOfScope = OUT_OF_SCOPE[program.id];
	if (outOfScope !== undefined) {
		test(`${title} [out of scope: ${outOfScope}]`, () => {
			const run = runTsval(program.code);
			assert.ok(run.threw && run.error instanceof TsvalInternalError, "an out-of-scope construct must be refused loudly, not silently mis-run");
			tally.outOfScope++;
		});
		continue;
	}
	const gap = KNOWN_GAPS[program.id];
	test(title, gap === undefined ? {} : { todo: gap }, async () => {
		const outcome = await classifyDifferential(program.code);
		if (outcome.kind === "mismatch") assert.fail(`${outcome.detail}\n--- program ---\n${program.code.trim()}`);
		if (gap !== undefined) tally.todo++;
		else if (outcome.kind === "both-threw") tally.bothThrew++;
		else tally.match++;
	});
}

after(() => {
	// eslint-disable-next-line no-console
	console.log(`ts-evaluator corpus: ${corpus.length} programs — ${tally.match} value-match, ${tally.bothThrew} both-threw, ${Object.keys(KNOWN_GAPS).length} known gaps (todo), ${tally.outOfScope} out of scope (refused loudly)`);
});
