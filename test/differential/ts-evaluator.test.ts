/**
 * Run the ts-evaluator corpus through the differential oracle.
 *
 * Every program must either match Node exactly, or be listed in KNOWN_GAPS with a reason — those run
 * as `todo` (reported, never silently passing, and visible the moment they start to pass). A program
 * where *both* sides throw counts as a pass but is tallied separately in the summary: agreement on
 * failure is weaker evidence than agreement on a value.
 */
import { test, after } from "node:test";
import assert from "node:assert";
import { classifyDifferential } from "./harness.ts";
import { loadCorpus } from "./ts-evaluator-corpus.ts";
import { KNOWN_GAPS } from "./ts-evaluator-gaps.ts";

const corpus = loadCorpus();
const tally = { match: 0, bothThrew: 0, todo: 0 };

for (const program of corpus) {
	const gap = KNOWN_GAPS[program.id];
	const title = `ts-evaluator ${program.id}: ${program.name}`;
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
	console.log(`ts-evaluator corpus: ${corpus.length} programs — ${tally.match} value-match, ${tally.bothThrew} both-threw, ${Object.keys(KNOWN_GAPS).length} known gaps (todo)`);
});
