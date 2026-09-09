/**
 * Build vendor/test262-sample from the full pinned checkout: the harness, LICENSE, and every 25th
 * policy-eligible language test in stable sorted order (deterministic, so the sample is reproducible
 * and the checked-in corpus stays small).
 */
// eslint-disable-next-line ts/no-restricted-imports -- sync fs (rmSync/mkdirSync/readdirSync/copyFileSync) has no equivalent in the async-only util/fs wrapper
import fs from "node:fs";
import * as path from "node:path";
import { FULL_ROOT, hasCorpus, loadTest262, SAMPLE_ROOT, TEST262_PIN } from "../test/differential/test262-corpus.ts";
import { policySkip } from "../test/differential/test262-run.ts";

const EVERY = 25;

if (!hasCorpus(FULL_ROOT)) {
	console.error("vendor/test262 is missing — run `npm run test262:fetch`");
	process.exit(2);
}

fs.rmSync(SAMPLE_ROOT, { "recursive": true, "force": true });
fs.mkdirSync(path.join(SAMPLE_ROOT, "harness"), { "recursive": true });
for (const name of fs.readdirSync(path.join(FULL_ROOT, "harness"))) {
	if (name.endsWith(".js")) { fs.copyFileSync(path.join(FULL_ROOT, "harness", name), path.join(SAMPLE_ROOT, "harness", name)); }
}

fs.copyFileSync(path.join(FULL_ROOT, "LICENSE"), path.join(SAMPLE_ROOT, "LICENSE"));

let eligible = 0;
let copied = 0;

for (const t of loadTest262(FULL_ROOT)) {
	if (policySkip(t) !== undefined) { continue; }
	const idx = eligible;

	eligible += 1;
	if (idx % EVERY !== 0) { continue; }
	const dest = path.join(SAMPLE_ROOT, "test/language", t.id);

	fs.mkdirSync(path.dirname(dest), { "recursive": true });
	fs.copyFileSync(path.join(FULL_ROOT, "test/language", t.id), dest);
	copied += 1;
}

fs.writeFileSync(
	path.join(SAMPLE_ROOT, "README.md"),
	`# test262 sample\n\nA deterministic 1-in-${EVERY} sample of the policy-eligible \`test/language\` tests from\n[tc39/test262](https://github.com/tc39/test262) at commit \`${TEST262_PIN}\` (BSD-3, see LICENSE), plus the harness.\nRegenerate with \`npm run test262:fetch && npm run test262:sample\`. ${copied} of ${eligible} eligible tests.\n`
);
console.log(`sample: ${copied} tests (of ${eligible} eligible) → ${path.relative(process.cwd(), SAMPLE_ROOT)}`);
