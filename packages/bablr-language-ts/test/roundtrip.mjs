// Round-trip oracle over tsval's supported-surface corpus: parse(src) → printSource → must equal src.
//
//   node test/roundtrip.mjs                       # sample corpora (what tsval checks in), all workers
//   node test/roundtrip.mjs --corpus ts-cases     # ts-cases | test262 | all
//   node test/roundtrip.mjs --full                # tsval's full pinned checkouts (slow)
//   node test/roundtrip.mjs --filter class/       # id substring filter
//   node test/roundtrip.mjs --limit 50 --jobs 4 --timeout 30000 --out test/reports/run.json
//
// Prints a status table split by "pure JS" vs "uses TS syntax" (the extend-vs-fork evidence: JS failures are
// esnext's, TS failures are the layer we're building), then the failure buckets by construct.
import { mkdirSync, writeFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { analyze } from "./analyze.mjs";
import { loadCorpus } from "./corpus.mjs";

const here = dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);

function opt(name, def) {
	const i = argv.indexOf(`--${name}`);

	return i >= 0 ? argv[i + 1] : def;
}

const flag = (name) => argv.includes(`--${name}`);

const corpusArg = opt("corpus", "all");
const corpora = corpusArg === "all" ? ["ts-cases", "test262"] : corpusArg.split(",");
const size = flag("full") ? "full" : "sample";
const filter = opt("filter", null);
const limit = Number(opt("limit", Infinity));
const jobs = Number(opt("jobs", Math.max(1, availableParallelism() - 1)));
const timeoutMs = Number(opt("timeout", 120_000));
const restartEvery = Number(opt("restart-every", 100));
const out = opt("out", resolve(here, "reports", `${size}-${corpora.join("+")}.json`));
const verbose = flag("verbose");
const fast = flag("fast"); // run workers with the validation/freeze shims (test/fast-record*.mjs, test/nofreeze.mjs)

// ── collect ────────────────────────────────────────────────────────────────────────────────────────────────────
const cases = [];
let skipped = 0;

for await (const c of loadCorpus({ "corpora": corpora, "size": size })) {
	if (c.skip !== undefined) {
		skipped++;
		continue;
	}

	if (filter && !c.id.includes(filter)) { continue; }
	cases.push(c);
	if (cases.length >= limit) { break; }
}

console.error(`${cases.length} eligible cases (${skipped} skipped by tsval's policy), ${jobs} workers, ${timeoutMs}ms timeout${fast ? ", fast shims" : ""}`);

// ── run ────────────────────────────────────────────────────────────────────────────────────────────────────────
const workerUrl = new URL("./roundtrip-worker.mjs", import.meta.url);
const results = new Array(cases.length);
let next = 0;
let done = 0;
const started = performance.now();

const fastArgv = ["--import", fileURLToPath(new URL("./fast-record-register.mjs", import.meta.url)), "--import", fileURLToPath(new URL("./nofreeze.mjs", import.meta.url))];
const spawn = () => new Worker(workerUrl, { "execArgv": fast ? fastArgv : [] });

function runOn(worker, served) {
	return new Promise((resolveSlot) => {
		const loop = () => {
			if (next >= cases.length) {
				worker.terminate();

				return resolveSlot();
			}

			if (served >= restartEvery) {
				worker.terminate();

				return resolveSlot(runOn(spawn(), 0));
			}

			const seq = next++;
			const c = cases[seq];
			let settled = false;
			const timer = setTimeout(() => {
				if (settled) { return; }
				settled = true;
				worker.terminate();
				results[seq] = { "status": "timeout", "ms": timeoutMs };
				finish(seq);
				resolveSlot(runOn(spawn(), 0));
			}, timeoutMs);
			const onMessage = (msg) => {
				if (settled || msg.seq !== seq) { return; }
				settled = true;
				clearTimeout(timer);
				worker.off("message", onMessage);
				worker.off("error", onError);
				results[seq] = msg;
				finish(seq);
				served++;
				loop();
			};

			const onError = (err) => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				results[seq] = { "status": "error", "message": `worker crashed: ${err?.message ?? err}`, "pos": null };
				finish(seq);
				resolveSlot(runOn(spawn(), 0));
			};

			worker.on("message", onMessage);
			worker.on("error", onError);
			worker.postMessage({ "seq": seq, "source": c.source });
		};

		loop();
	});
}

function finish(seq) {
	done++;
	const r = results[seq];

	if (verbose || r.status !== "pass") {
		console.error(`[${done}/${cases.length}] ${r.status.padEnd(8)} ${r.ms}ms ${cases[seq].corpus}/${cases[seq].id}${r.message ? ` — ${r.message}` : ""}`);
	} else if (done % 50 === 0) {
		console.error(`[${done}/${cases.length}] … ${Math.round((performance.now() - started) / 1000)}s`);
	}
}

await Promise.all(Array.from({ "length": Math.min(jobs, cases.length) }, () => runOn(spawn(), 0)));

// ── analyze + report ───────────────────────────────────────────────────────────────────────────────────────────
const stripped = results.map((r, i) => ({ "corpus": cases[i].corpus, "id": cases[i].id, ...r }));

mkdirSync(dirname(out), { "recursive": true });
const meta = { "size": size, "corpora": corpora, "fast": fast, "grammar": process.env.GRAMMAR ?? "lib/grammar.js", "ran": new Date().toISOString() };

writeFileSync(out, JSON.stringify({ ...meta, "results": stripped }, null, 1)); // raw results first: analysis may fail
const analysis = analyze(cases, results, { "size": size, "started": started });

console.log("\n" + analysis.text);

writeFileSync(out, JSON.stringify({ ...meta, "tally": analysis.tally, "results": stripped }, null, 1));
console.log(`\nreport: ${out}`);
