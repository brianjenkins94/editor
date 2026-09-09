// Analysis of a round-trip run: status table, the feature census of failing statements ranked against passing
// cases, coarse position buckets, and the TS-feature census (what the TS layer must cover, by frequency).
//
//   node test/analyze.mjs test/reports/<run>.json        # re-analyze a saved run (re-reads the corpus sources)
import { readFileSync } from "node:fs";
import { bucketKey, features, locate, parse, statementAt, textFeatures, usesTsSyntax } from "./classify.mjs";
import { loadCorpus } from "./corpus.mjs";

const pad = (s, n) => String(s).padStart(n);

export function analyze(cases, results, { size, started, top = 40 } = {}) {
	const rows = cases.map((c, i) => {
		const r = results[i];
		const sf = parse(c.name, c.source);
		const row = { "corpus": c.corpus, "id": c.id, "bytes": c.source.length, "usesTs": usesTsSyntax(sf), ...r };

		row.fileFeatures = [...features(sf, sf), ...textFeatures(c.source)];
		if (r.status !== "pass") {
			if (typeof r.pos === "number") {
				row.at = locate(sf, c.source, r.pos);
				row.bucket = bucketKey(row.at);
				const stmt = statementAt(sf, r.pos);

				row.failingStatement = stmt ? stmt.getText(sf).slice(0, 200) : null;
				row.suspects = stmt ? [...features(stmt, sf)] : [];
				row.suspects.push(...textFeatures(c.source));
			} else {
				row.bucket = `(${r.status}: ${r.message ?? "no position"})`;
				row.suspects = row.fileFeatures;
			}
		}

		return row;
	});

	const lines = [];
	const out = (s = "") => lines.push(s);

  // status table
	const tally = new Map();

	for (const row of rows) {
		const key = `${row.corpus} ${row.usesTs ? "TS" : "JS"}`;
		const t = tally.get(key) ?? { "cases": 0, "pass": 0, "mismatch": 0, "error": 0, "timeout": 0 };

		t.cases++;
		t[row.status]++;
		tally.set(key, t);
	}

	out(`round-trip: ${size} corpora, ${rows.length} cases${started ? `, ${Math.round((performance.now() - started) / 1000)}s` : ""}`);
	out();
	out(`${"corpus".padEnd(24)}${pad("cases", 7)}${pad("pass", 7)}${pad("mismatch", 10)}${pad("error", 7)}${pad("timeout", 9)}${pad("pass%", 8)}`);
	for (const [key, t] of [...tally].sort()) { out(`${key.padEnd(24)}${pad(t.cases, 7)}${pad(t.pass, 7)}${pad(t.mismatch, 10)}${pad(t.error, 7)}${pad(t.timeout, 9)}${pad(((100 * t.pass) / t.cases).toFixed(1), 8)}`); }

  // suspect features: features of failing statements, ranked against features seen anywhere in passing cases
	const passCount = new Map();

	for (const r of rows) {
		if (r.status === "pass") {
			for (const f of r.fileFeatures) { passCount.set(f, (passCount.get(f) ?? 0) + 1); }
		}
	}

	const suspectTable = (group, title) => {
		const failCount = new Map();
		const failExamples = new Map();

		for (const r of group) {
			if (r.status === "pass") { continue; }
			for (const f of new Set(r.suspects)) {
				failCount.set(f, (failCount.get(f) ?? 0) + 1);
				const ex = failExamples.get(f) ?? [];

				if (ex.length < 2) { ex.push(`${r.corpus}/${r.id}${r.at ? `:${r.at.line}` : ""}`); }
				failExamples.set(f, ex);
			}
		}

		const list = [...failCount]
			.map(([f, fails]) => ({ "f": f, "fails": fails, "passes": passCount.get(f) ?? 0 }))
			.sort((a, b) => ((a.passes === 0) !== (b.passes === 0) ? (a.passes === 0 ? -1 : 1) : b.fails - a.fails));

		out();
		out(`suspect features in failing ${title} statements (never seen in any passing case first; then by failure count)`);
		out(`${pad("fails", 6)}${pad("passes", 8)}  feature`);
		for (const s of list.slice(0, top)) { out(`${pad(s.fails, 6)}${pad(s.passes, 8)}  ${s.f.padEnd(34)} ${failExamples.get(s.f).join("  ")}`); }

		return list;
	};

	const suspects = suspectTable(rows.filter((r) => !r.usesTs), "pure-JS");
	const tsSuspects = suspectTable(rows.filter((r) => r.usesTs), "TS-using");

  // coarse position buckets
	const buckets = new Map();

	for (const row of rows) {
		if (row.status === "pass") { continue; }
		const key = `${row.usesTs ? "TS" : "JS"} | ${row.bucket}`;
		const b = buckets.get(key) ?? { "count": 0, "examples": [] };

		b.count++;
		if (b.examples.length < 2) { b.examples.push({ "id": `${row.corpus}/${row.id}`, "line": row.at?.line, "excerpt": row.at?.excerpt }); }
		buckets.set(key, b);
	}

	const sorted = [...buckets].sort((a, b) => b[1].count - a[1].count);
	const js = sorted.filter(([k]) => k.startsWith("JS |"));

	out();
	out(`coarse position buckets — pure-JS failures (position = last committed text; the failure is at or after it): ${js.length} buckets`);
	for (const [key, b] of js.slice(0, 15)) {
		out(`  ${pad(b.count, 4)}  ${key.slice(5)}`);
		for (const ex of b.examples) { out(`          ${ex.id}${ex.line ? `:${ex.line}` : ""}  ${ex.excerpt ?? ""}`); }
	}

  // TS census over all TS-using cases
	const tsCount = new Map();
	let tsCases = 0;

	for (const r of rows) {
		if (!r.usesTs) { continue; }
		tsCases++;
		for (const f of r.fileFeatures) {
			if (f.startsWith("TS:")) { tsCount.set(f, (tsCount.get(f) ?? 0) + 1); }
		}
	}

	out();
	out(`TypeScript feature census over ${tsCases} TS-using cases (what the TS layer must cover, by frequency)`);
	for (const [f, n] of [...tsCount].sort((a, b) => b[1] - a[1]).slice(0, top)) { out(`${pad(n, 6)}  ${f}`); }

	return { "rows": rows, "tally": Object.fromEntries(tally), "suspects": suspects, "tsSuspects": tsSuspects, "buckets": Object.fromEntries(sorted), "tsCensus": Object.fromEntries(tsCount), "text": lines.join("\n") };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""))) {
	const file = process.argv[2];
	const report = JSON.parse(readFileSync(file, "utf8"));
	const wanted = new Map(report.results.map((r) => [`${r.corpus}/${r.id}`, r]));
	const cases = [];
	const results = [];

	for await (const c of loadCorpus({ "corpora": report.corpora, "size": report.size })) {
		const r = wanted.get(`${c.corpus}/${c.id}`);

		if (!r) { continue; }
		cases.push(c);
		results.push(r);
	}

	console.log(analyze(cases, results, { "size": report.size, "top": Number(process.argv[3] ?? 40) }).text);
}
