// List failing cases of a saved run with the statement they failed in.  node test/failures.mjs <report.json> [corpusFilter]
import { readFileSync } from "node:fs";
import { analyze } from "./analyze.mjs";
import { loadCorpus } from "./corpus.mjs";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
const filter = process.argv[3];
const wanted = new Map(report.results.map((result) => [`${result.corpus}/${result.id}`, result]));
const cases = [];
const results = [];

for await (const testCase of loadCorpus({ "corpora": report.corpora, "size": report.size })) {
	const key = `${testCase.corpus}/${testCase.id}`;
	const result = wanted.get(key);

	if (result && result.status !== "pass" && (!filter || key.includes(filter))) {
		cases.push(testCase);
		results.push(result);
	}
}

const { rows } = analyze(cases, results, { "size": report.size });

for (const row of rows) {
	const stmt = (row.failingStatement ?? "(no position)").replace(/\s+/gu, " ").slice(0, 110);

	console.log(`${row.corpus}/${row.id}  [${row.status}${row.message ? ": " + row.message.slice(0, 40) : ""}] ${row.usesTs ? "TS" : "JS"}\n    ${stmt}`);
}

console.log(`${rows.length} failures`);
