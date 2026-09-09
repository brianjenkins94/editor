/**
 * Full test262 run (vendor/test262, pinned) → bucketed report. The dev loop from ASSIGNMENT §5 S0:
 * run corpus → bucket failures → implement to close gaps.
 *
 *   node scripts/test262-report.ts [--dir statements/class] [--limit N] [--json out.json]
 */
import * as fs from "@brianjenkins94/util/fs";
import { FULL_ROOT, hasCorpus, loadTest262 } from "../test/differential/test262-corpus.ts";
import { knownGap } from "../test/differential/test262-gaps.ts";
import { runTest262 } from "../test/differential/test262-run.ts";

const args = process.argv.slice(2);

function opt(name: string): string | undefined {
	const i = args.indexOf(name);

	return i === -1 ? undefined : args[i + 1];
}

const dir = opt("--dir");
const limit = Number(opt("--limit") ?? Infinity);
const jsonOut = opt("--json");

if (!hasCorpus(FULL_ROOT)) {
	console.error("vendor/test262 is missing — run `npm run test262:fetch`");
	process.exit(2);
}

// Guest code can leave async work that rejects after its test finished; a plain script would die on
// it (node:test shields the sample run). Count it instead of crashing a 16k-test run.
let lateRejections = 0;

process.on("unhandledRejection", () => { lateRejections += 1; });

const counts = { "pass": 0, "fail": 0, "control-failed": 0, "skipped": 0 };
const failures: { "id": string; "reason": string; "gap"?: string }[] = [];
const skipReasons = new Map<string, number>();
const controlReasons = new Map<string, number>();
let n = 0;
const started = Date.now();

for (const t of loadTest262(FULL_ROOT, (id) => dir === undefined || id.startsWith(dir))) {
	const idx = n;

	n += 1;
	if (idx >= limit) { break; }
	let outcome: Awaited<ReturnType<typeof runTest262>>;

	try {
		outcome = await runTest262(FULL_ROOT, t);
	} catch (error) {
		outcome = { "kind": "fail", "reason": `runner error: ${String((error as Error)?.message ?? error).slice(0, 120)}` };
	}

	counts[outcome.kind] += 1;
	if (outcome.kind === "fail") { failures.push({ "id": t.id, "reason": outcome.reason, "gap": knownGap(t.id) }); }
	if (outcome.kind === "skipped") { skipReasons.set(outcome.reason, (skipReasons.get(outcome.reason) ?? 0) + 1); }
	if (outcome.kind === "control-failed") { controlReasons.set(outcome.reason.slice(0, 80), (controlReasons.get(outcome.reason.slice(0, 80)) ?? 0) + 1); }
	if (n % 500 === 0) { console.error(`… ${n} (${((Date.now() - started) / 1000).toFixed(0)}s) pass=${counts.pass} fail=${counts.fail}`); }
}

function bucket<T>(items: T[], key: (t: T) => string): [string, number][] {
	const m = new Map<string, number>();

	for (const it of items) { m.set(key(it), (m.get(key(it)) ?? 0) + 1); }

	return [...m].sort((a, b) => b[1] - a[1]);
}

const topDir = (id: string): string => id.split("/").slice(0, 2).join("/");
const reasonKey = (reason: string): string => reason.replace(/'[^']*'/g, "'…'").replace(/\d+/g, "N").slice(0, 90);

const unknownFailures = failures.filter((f) => f.gap === undefined);

console.log(`\n# test262 report (${n} tests, ${((Date.now() - started) / 1000).toFixed(0)}s)\n`);
console.log(`pass ${counts.pass} · fail ${counts.fail} (${unknownFailures.length} not in known gaps) · inconclusive ${counts["control-failed"]} · skipped ${counts.skipped} · late rejections ${lateRejections}`);
const eligible = counts.pass + counts.fail;

if (eligible > 0) { console.log(`pass rate on eligible: ${((100 * counts.pass) / eligible).toFixed(1)}%`); }

console.log("\n## failures by directory");
for (const [k, c] of bucket(unknownFailures, (f) => topDir(f.id)).slice(0, 40)) { console.log(`${String(c).padStart(6)}  ${k}`); }
console.log("\n## failures by reason");
for (const [k, c] of bucket(unknownFailures, (f) => reasonKey(f.reason)).slice(0, 40)) { console.log(`${String(c).padStart(6)}  ${k}`); }
console.log("\n## skipped by policy");
for (const [k, c] of [...skipReasons].sort((a, b) => b[1] - a[1])) { console.log(`${String(c).padStart(6)}  ${k}`); }
console.log("\n## inconclusive (Node fails too) — top reasons");
for (const [k, c] of [...controlReasons].sort((a, b) => b[1] - a[1]).slice(0, 10)) { console.log(`${String(c).padStart(6)}  ${k}`); }

if (jsonOut !== undefined) { fs.writeFileSync(jsonOut, JSON.stringify({ "counts": counts, "failures": failures }, null, 2)); }
