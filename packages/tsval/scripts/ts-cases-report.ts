/**
 * Full run of TypeScript's compiler test cases (vendor/typescript-cases, pinned) as differential
 * inputs → bucketed report.
 *
 *   node scripts/ts-cases-report.ts [--dir conformance/classes] [--limit N] [--json out.json]
 */
import type { TsCaseOutcome } from "../test/differential/ts-cases-run.ts";
import * as fs from "@brianjenkins94/util/fs";
import { FULL_ROOT, hasCorpus, loadTsCases } from "../test/differential/ts-cases-corpus.ts";
import { knownGap } from "../test/differential/ts-cases-gaps.ts";
import { CaseRunner } from "../test/differential/ts-cases-runner.ts";

const args = process.argv.slice(2);

function opt(name: string): string | undefined {
	const i = args.indexOf(name);

	return i === -1 ? undefined : args[i + 1];
}

const dir = opt("--dir");
const limit = Number(opt("--limit") ?? Infinity);
const jsonOut = opt("--json");

if (!hasCorpus(FULL_ROOT)) {
	console.error("vendor/typescript-cases is missing — run `npm run ts-cases:fetch`");
	process.exit(2);
}

const runner = new CaseRunner(); // cases run in a worker: a heap limit and a wall-clock kill bound each one

const counts = { "match": 0, "both-threw": 0, "mismatch": 0, "inconclusive": 0, "skipped": 0 };
const mismatches: { "id": string; "reason": string; "gap"?: string }[] = [];
const bothThrew = new Map<string, number>();
const skipReasons = new Map<string, number>();
const inconclusiveReasons = new Map<string, number>();
let n = 0;
const started = Date.now();

for (const t of loadTsCases(FULL_ROOT, (id) => dir === undefined || id.startsWith(dir))) {
	const idx = n;

	n += 1;
	if (idx >= limit) { break; }
	const outcome: TsCaseOutcome = await runner.run(FULL_ROOT, t.id);

	counts[outcome.kind] += 1;
	if (outcome.kind === "mismatch") { mismatches.push({ "id": t.id, "reason": outcome.reason, "gap": knownGap(t.id) }); }
	if (outcome.kind === "both-threw") { bothThrew.set(outcome.node.replace(/'[^']*'/g, "'…'").slice(0, 60), (bothThrew.get(outcome.node.replace(/'[^']*'/g, "'…'").slice(0, 60)) ?? 0) + 1); }
	if (outcome.kind === "skipped") { skipReasons.set(outcome.reason, (skipReasons.get(outcome.reason) ?? 0) + 1); }
	if (outcome.kind === "inconclusive") { inconclusiveReasons.set(outcome.reason, (inconclusiveReasons.get(outcome.reason) ?? 0) + 1); }
	if (n % 1000 === 0) { console.error(`… ${n} (${((Date.now() - started) / 1000).toFixed(0)}s) match=${counts.match} both-threw=${counts["both-threw"]} mismatch=${counts.mismatch}`); }
}

function bucket<T>(items: T[], key: (t: T) => string): [string, number][] {
	const m = new Map<string, number>();

	for (const it of items) { m.set(key(it), (m.get(key(it)) ?? 0) + 1); }

	return [...m].sort((a, b) => b[1] - a[1]);
}

const topDir = (id: string): string => id.split("/").slice(0, 2).join("/");
const reasonKey = (reason: string): string => reason.replace(/'[^']*'/g, "'…'").replace(/\d+/g, "N").slice(0, 100);

await runner.close();
const { lateRejections } = runner;
const unknown = mismatches.filter((m) => m.gap === undefined);

console.log(`\n# TypeScript cases report (${n} cases, ${((Date.now() - started) / 1000).toFixed(0)}s)\n`);
console.log(`match ${counts.match} · both-threw ${counts["both-threw"]} · mismatch ${counts.mismatch} (${unknown.length} not in known gaps) · inconclusive ${counts.inconclusive} · skipped ${counts.skipped} · late rejections ${lateRejections}`);
const eligible = counts.match + counts["both-threw"] + counts.mismatch;

if (eligible > 0) { console.log(`agreement on eligible: ${((100 * (counts.match + counts["both-threw"])) / eligible).toFixed(1)}% (${((100 * counts.match) / eligible).toFixed(1)}% by value)`); }
console.log("\n## mismatches by directory");
for (const [k, c] of bucket(unknown, (m) => topDir(m.id)).slice(0, 30)) { console.log(`${String(c).padStart(6)}  ${k}`); }
console.log("\n## mismatches by reason");
for (const [k, c] of bucket(unknown, (m) => reasonKey(m.reason)).slice(0, 40)) { console.log(`${String(c).padStart(6)}  ${k}`); }
console.log("\n## both threw — top errors (agreement on failure)");
for (const [k, c] of [...bothThrew].sort((a, b) => b[1] - a[1]).slice(0, 12)) { console.log(`${String(c).padStart(6)}  ${k}`); }
console.log("\n## inconclusive");
for (const [k, c] of [...inconclusiveReasons].sort((a, b) => b[1] - a[1])) { console.log(`${String(c).padStart(6)}  ${k}`); }
console.log("\n## skipped by policy");
for (const [k, c] of [...skipReasons].sort((a, b) => b[1] - a[1])) { console.log(`${String(c).padStart(6)}  ${k}`); }

if (jsonOut !== undefined) { fs.writeFileSync(jsonOut, JSON.stringify({ "counts": counts, "mismatches": mismatches }, null, 2)); }
