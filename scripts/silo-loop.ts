/**
 * The static→dynamic loop on one file: silo's static prediction + reaches vs tsval's canary run.
 *
 *   npm run silo:loop -- path/to/program.ts [--explore] [--json]
 *
 * Prints what static analysis predicted, what runtime actually reached (with resolved resources),
 * and the verdict of the divergence predicate `runtime-caps ⊆ static-caps`. Exit code 1 on a
 * divergence (or an error), so it can gate a pipeline. Needs `../lib` (the static kernel) checked
 * out next to this repo.
 */
import fs from "node:fs";
import { exploreCanary, runCanary, type CanaryEvent } from "../src/canary.ts";
import { loadSilo } from "../test/integration/silo.ts";

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const explore = args.includes("--explore");
const json = args.includes("--json");
if (file === undefined) {
	console.error("usage: npm run silo:loop -- <file.ts> [--explore] [--json]");
	process.exit(2);
}

const silo = await loadSilo();
if (silo === undefined) {
	console.error("the static kernel (../lib/util/silo, loaded through lib's tsx) is not available");
	process.exit(2);
}

const code = fs.readFileSync(file, "utf8");
const predicted = silo.detect(code);
const reaches = silo.findReach(file, code);
const fmt = (e: { capability: string; value: string; callee: string }): string => `${e.capability.padEnd(9)} ${e.callee} → ${e.value}`;

let observed: CanaryEvent[];
let ok: boolean;
let divergence: CanaryEvent | undefined;
let detail: unknown;
if (explore) {
	const report = exploreCanary(code, { predicted });
	observed = report.observed;
	ok = report.ok;
	divergence = report.paths.find((p) => p.divergence !== undefined)?.divergence;
	detail = { paths: report.paths.length, truncated: report.truncated };
} else {
	const report = runCanary(code, { predicted });
	observed = report.observed;
	ok = report.ok;
	divergence = report.divergence;
	detail = { completion: report.completion, error: report.error === undefined ? undefined : String(report.error) };
}

const runtimeCaps = [...new Set(observed.map((e) => e.capability))].sort();
const unresolvedStatically = observed.filter((e) => !reaches.some((r) => r.capability === e.capability && r.value === e.value));

if (json) {
	console.log(JSON.stringify({ file, predicted, reaches, observed, runtimeCaps, ok, divergence, unresolvedStatically, detail }, null, 2));
} else {
	console.log(`# ${file}\n`);
	console.log(`static predicted : ${predicted.length > 0 ? predicted.join(", ") : "(nothing)"}`);
	console.log(`static reaches   : ${reaches.length > 0 ? "" : "(none)"}`);
	for (const r of reaches) console.log(`  ${fmt(r)}  [${r.line}:${r.column}]`);
	console.log(`\nruntime reached  : ${runtimeCaps.length > 0 ? runtimeCaps.join(", ") : "(nothing)"}${explore ? `  (${(detail as { paths: number }).paths} paths explored)` : ""}`);
	for (const e of observed) console.log(`  ${fmt(e)}${e.path !== undefined && e.path > 0 ? `  [path ${e.path}]` : ""}`);
	if (unresolvedStatically.length > 0) {
		console.log(`\nresolved only at runtime:`);
		for (const e of unresolvedStatically) console.log(`  ${fmt(e)}`);
	}
	const tripped = divergence === undefined ? "the run failed" : `${divergence.capability} (${divergence.callee} → ${divergence.value}) is outside the predicted set`;
	console.log(`\nverdict: ${ok ? "OK — runtime ⊆ static" : `DIVERGENCE — ${tripped}`}`);
}
process.exit(ok ? 0 : 1);
