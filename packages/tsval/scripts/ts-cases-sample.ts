/**
 * Build vendor/typescript-cases-sample from the full pinned checkout: LICENSE.txt, the third-party
 * notice, and every 10th policy-eligible case in stable sorted order (deterministic, small).
 */
// eslint-disable-next-line ts/no-restricted-imports -- sync fs (rmSync/mkdirSync/copyFileSync) has no equivalent in the async-only util/fs wrapper
import fs from "node:fs";
import * as path from "node:path";
import { FULL_ROOT, hasCorpus, loadTsCases, policySkip, SAMPLE_ROOT, TS_CASES_PIN } from "../test/differential/ts-cases-corpus.ts";

const EVERY = 10;

if (!hasCorpus(FULL_ROOT)) {
	console.error("vendor/typescript-cases is missing — run `npm run ts-cases:fetch`");
	process.exit(2);
}

fs.rmSync(SAMPLE_ROOT, { "recursive": true, "force": true });
fs.mkdirSync(SAMPLE_ROOT, { "recursive": true });
for (const name of ["LICENSE.txt", "ThirdPartyNoticeText.txt"]) {
	if (fs.existsSync(path.join(FULL_ROOT, name))) { fs.copyFileSync(path.join(FULL_ROOT, name), path.join(SAMPLE_ROOT, name)); }
}

let eligible = 0;
let copied = 0;

for (const t of loadTsCases(FULL_ROOT)) {
	if (policySkip(t) !== undefined) { continue; }
	const idx = eligible;

	eligible += 1;
	if (idx % EVERY !== 0) { continue; }
	const dest = path.join(SAMPLE_ROOT, "tests/cases", t.id);

	fs.mkdirSync(path.dirname(dest), { "recursive": true });
	fs.writeFileSync(dest, t.source);
	copied += 1;
}

fs.writeFileSync(
	path.join(SAMPLE_ROOT, "README.md"),
	`# TypeScript compiler test cases — sample\n\nA deterministic 1-in-${EVERY} sample of the policy-eligible cases from\n[microsoft/TypeScript](https://github.com/microsoft/TypeScript) \`tests/cases/{compiler,conformance}\` at tag \`${TS_CASES_PIN}\`\n(Apache-2.0, see LICENSE.txt and ThirdPartyNoticeText.txt). Used as differential INPUTS (tsval vs tsc-emit-in-Node);\nthe cases themselves assert nothing at runtime. Regenerate with \`npm run ts-cases:fetch && npm run ts-cases:sample\`.\n${copied} of ${eligible} eligible cases.\n`
);
console.log(`sample: ${copied} cases (of ${eligible} eligible) → ${path.relative(process.cwd(), SAMPLE_ROOT)}`);
