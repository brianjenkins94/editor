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
	const index = args.indexOf(name);

	return index === -1 ? undefined : args[index + 1];
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

process.on("unhandledRejection", () => {
	lateRejections += 1;
});

const counts = { "pass": 0, "fail": 0, "control-failed": 0, "skipped": 0 };
const failures: { "id": string; "reason": string; "gap"?: string }[] = [];
const skipReasons = new Map<string, number>();
const controlReasons = new Map<string, number>();
let total = 0;
const started = Date.now();

for (const testCase of loadTest262(FULL_ROOT, (id) => dir === undefined || id.startsWith(dir))) {
	const idx = total;

	total += 1;
	if (idx >= limit) {
		break;
	}

	let outcome: Awaited<ReturnType<typeof runTest262>>;

	try {
		outcome = await runTest262(FULL_ROOT, testCase);
	} catch (error) {
		outcome = { "kind": "fail", "reason": `runner error: ${String((error as Error)?.message ?? error).slice(0, 120)}` };
	}

	counts[outcome.kind] += 1;
	if (outcome.kind === "fail") {
		failures.push({ "id": testCase.id, "reason": outcome.reason, "gap": knownGap(testCase.id) });
	}

	if (outcome.kind === "skipped") {
		skipReasons.set(outcome.reason, (skipReasons.get(outcome.reason) ?? 0) + 1);
	}

	if (outcome.kind === "control-failed") {
		const controlKey = outcome.reason.slice(0, 80);

		controlReasons.set(controlKey, (controlReasons.get(controlKey) ?? 0) + 1);
	}

	if (total % 500 === 0) {
		console.error(`… ${total} (${((Date.now() - started) / 1000).toFixed(0)}s) pass=${counts.pass} fail=${counts.fail}`);
	}
}

function bucket<T>(items: T[], key: (t: T) => string): [string, number][] {
	return [...Map.groupBy(items, key)]
		.map(([name, group]): [string, number] => [name, group.length])
		.sort((left, right) => right[1] - left[1]);
}

const topDir = (id: string): string => id.split("/").slice(0, 2).join("/");
const reasonKey = (reason: string): string => reason.replace(/'[^']*'/gu, "'…'").replace(/\d+/gu, "N").slice(0, 90);

const unknownFailures = failures.filter((failure) => failure.gap === undefined);

console.log(`\n# test262 report (${total} tests, ${((Date.now() - started) / 1000).toFixed(0)}s)\n`);
console.log(`pass ${counts.pass} · fail ${counts.fail} (${unknownFailures.length} not in known gaps) · inconclusive ${counts["control-failed"]} · skipped ${counts.skipped} · late rejections ${lateRejections}`);
const eligible = counts.pass + counts.fail;

if (eligible > 0) {
	console.log(`pass rate on eligible: ${((100 * counts.pass) / eligible).toFixed(1)}%`);
}

console.log("\n## failures by directory");
for (const [key, count] of bucket(unknownFailures, (failure) => topDir(failure.id)).slice(0, 40)) {
	console.log(`${String(count).padStart(6)}  ${key}`);
}

console.log("\n## failures by reason");
for (const [key, count] of bucket(unknownFailures, (failure) => reasonKey(failure.reason)).slice(0, 40)) {
	console.log(`${String(count).padStart(6)}  ${key}`);
}

console.log("\n## skipped by policy");
for (const [key, count] of [...skipReasons].sort((left, right) => right[1] - left[1])) {
	console.log(`${String(count).padStart(6)}  ${key}`);
}

console.log("\n## inconclusive (Node fails too) — top reasons");
for (const [key, count] of [...controlReasons].sort((left, right) => right[1] - left[1]).slice(0, 10)) {
	console.log(`${String(count).padStart(6)}  ${key}`);
}

if (jsonOut !== undefined) {
	fs.writeFileSync(jsonOut, JSON.stringify({ "counts": counts, "failures": failures }, null, 2));
}
