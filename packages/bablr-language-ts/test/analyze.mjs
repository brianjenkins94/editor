// Analysis of a round-trip run: status table, the feature census of failing statements ranked against passing
// cases, coarse position buckets, and the TS-feature census (what the TS layer must cover, by frequency).
//
//   node test/analyze.mjs test/reports/<run>.json        # re-analyze a saved run (re-reads the corpus sources)
import { readFileSync } from "node:fs";
import { isEntry } from "@brianjenkins94/util/env";
import { bucketKey, features, locate, parse, statementAt, textFeatures, usesTsSyntax } from "./classify.mjs";
import { loadCorpus } from "./corpus.mjs";

const pad = (value, width) => String(value).padStart(width);

export function analyze(cases, results, { size, started, top = 40 } = {}) {
	const rows = cases.map((testCase, index) => {
		const result = results[index];
		const sf = parse(testCase.name, testCase.source);
		const row = { "corpus": testCase.corpus, "id": testCase.id, "bytes": testCase.source.length, "usesTs": usesTsSyntax(sf), ...result };

		row.fileFeatures = [...features(sf, sf), ...textFeatures(testCase.source)];
		if (result.status !== "pass") {
			if (typeof result.pos === "number") {
				row.at = locate(sf, testCase.source, result.pos);
				row.bucket = bucketKey(row.at);
				const stmt = statementAt(sf, result.pos);

				row.failingStatement = stmt ? stmt.getText(sf).slice(0, 200) : null;
				row.suspects = stmt ? [...features(stmt, sf)] : [];
				row.suspects.push(...textFeatures(testCase.source));
			} else {
				row.bucket = `(${result.status}: ${result.message ?? "no position"})`;
				row.suspects = row.fileFeatures;
			}
		}

		return row;
	});

	const lines = [];
	const out = (text = "") => lines.push(text);

  // status table
	const tally = new Map();

	for (const row of rows) {
		const key = `${row.corpus} ${row.usesTs ? "TS" : "JS"}`;
		const entry = tally.get(key) ?? { "cases": 0, "pass": 0, "mismatch": 0, "error": 0, "timeout": 0 };

		entry.cases += 1;
		entry[row.status] += 1;
		tally.set(key, entry);
	}

	out(`round-trip: ${size} corpora, ${rows.length} cases${started ? `, ${Math.round((performance.now() - started) / 1000)}s` : ""}`);
	out();
	out(`${"corpus".padEnd(24)}${pad("cases", 7)}${pad("pass", 7)}${pad("mismatch", 10)}${pad("error", 7)}${pad("timeout", 9)}${pad("pass%", 8)}`);
	for (const [key, entry] of [...tally].sort()) {
		out(`${key.padEnd(24)}${pad(entry.cases, 7)}${pad(entry.pass, 7)}${pad(entry.mismatch, 10)}${pad(entry.error, 7)}${pad(entry.timeout, 9)}${pad(((100 * entry.pass) / entry.cases).toFixed(1), 8)}`);
	}

  // suspect features: features of failing statements, ranked against features seen anywhere in passing cases
	const passCount = new Map();

	for (const row of rows) {
		if (row.status === "pass") {
			for (const feature of row.fileFeatures) {
				passCount.set(feature, (passCount.get(feature) ?? 0) + 1);
			}
		}
	}

	const suspectTable = (group, title) => {
		const failCount = new Map();
		const failExamples = new Map();

		for (const row of group) {
			if (row.status !== "pass") {
				for (const feature of new Set(row.suspects)) {
					failCount.set(feature, (failCount.get(feature) ?? 0) + 1);
					const ex = failExamples.get(feature) ?? [];

					if (ex.length < 2) {
						ex.push(`${row.corpus}/${row.id}${row.at ? `:${row.at.line}` : ""}`);
					}

					failExamples.set(feature, ex);
				}
			}
		}

		const list = [...failCount]
			.map(([feature, fails]) => ({ "f": feature, "fails": fails, "passes": passCount.get(feature) ?? 0 }))
			.sort((first, second) => {
				if ((first.passes === 0) !== (second.passes === 0)) {
					return first.passes === 0 ? -1 : 1;
				}

				return second.fails - first.fails;
			});

		out();
		out(`suspect features in failing ${title} statements (never seen in any passing case first; then by failure count)`);
		out(`${pad("fails", 6)}${pad("passes", 8)}  feature`);
		for (const suspect of list.slice(0, top)) {
			out(`${pad(suspect.fails, 6)}${pad(suspect.passes, 8)}  ${suspect.f.padEnd(34)} ${failExamples.get(suspect.f).join("  ")}`);
		}

		return list;
	};

	const suspects = suspectTable(rows.filter((row) => !row.usesTs), "pure-JS");
	const tsSuspects = suspectTable(rows.filter((row) => row.usesTs), "TS-using");

  // coarse position buckets
	const buckets = new Map();

	for (const row of rows) {
		if (row.status !== "pass") {
			const key = `${row.usesTs ? "TS" : "JS"} | ${row.bucket}`;
			const bucket = buckets.get(key) ?? { "count": 0, "examples": [] };

			bucket.count += 1;
			if (bucket.examples.length < 2) {
				bucket.examples.push({ "id": `${row.corpus}/${row.id}`, "line": row.at?.line, "excerpt": row.at?.excerpt });
			}

			buckets.set(key, bucket);
		}
	}

	const sorted = [...buckets].sort((first, second) => second[1].count - first[1].count);
	const js = sorted.filter(([key]) => key.startsWith("JS |"));

	out();
	out(`coarse position buckets — pure-JS failures (position = last committed text; the failure is at or after it): ${js.length} buckets`);
	for (const [key, bucket] of js.slice(0, 15)) {
		out(`  ${pad(bucket.count, 4)}  ${key.slice(5)}`);
		for (const ex of bucket.examples) {
			out(`          ${ex.id}${ex.line ? `:${ex.line}` : ""}  ${ex.excerpt ?? ""}`);
		}
	}

  // TS census over all TS-using cases
	const tsCount = new Map();
	let tsCases = 0;

	for (const row of rows) {
		if (row.usesTs) {
			tsCases += 1;
			for (const feature of row.fileFeatures) {
				if (feature.startsWith("TS:")) {
					tsCount.set(feature, (tsCount.get(feature) ?? 0) + 1);
				}
			}
		}
	}

	out();
	out(`TypeScript feature census over ${tsCases} TS-using cases (what the TS layer must cover, by frequency)`);
	for (const [feature, count] of [...tsCount].sort((first, second) => second[1] - first[1]).slice(0, top)) {
		out(`${pad(count, 6)}  ${feature}`);
	}

	return { "rows": rows, "tally": Object.fromEntries(tally), "suspects": suspects, "tsSuspects": tsSuspects, "buckets": Object.fromEntries(sorted), "tsCensus": Object.fromEntries(tsCount), "text": lines.join("\n") };
}

if (isEntry(import.meta)) {
	const file = process.argv[2];
	const report = JSON.parse(readFileSync(file, "utf8"));
	const wanted = new Map(report.results.map((result) => [`${result.corpus}/${result.id}`, result]));
	const cases = [];
	const results = [];

	for await (const testCase of loadCorpus({ "corpora": report.corpora, "size": report.size })) {
		const result = wanted.get(`${testCase.corpus}/${testCase.id}`);

		if (result) {
			cases.push(testCase);
			results.push(result);
		}
	}

	console.log(analyze(cases, results, { "size": report.size, "top": Number(process.argv[3] ?? 40) }).text);
}
