// List failing cases of a saved run with the statement they failed in.  node test/failures.mjs <report.json> [corpusFilter]
import { readFileSync } from 'node:fs';
import { loadCorpus } from './corpus.mjs';
import { analyze } from './analyze.mjs';
const report = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const filter = process.argv[3];
const wanted = new Map(report.results.map((r) => [`${r.corpus}/${r.id}`, r]));
const cases = [], results = [];
for await (const c of loadCorpus({ corpora: report.corpora, size: report.size })) {
  const r = wanted.get(`${c.corpus}/${c.id}`);
  if (!r || r.status === 'pass') continue;
  if (filter && !`${c.corpus}/${c.id}`.includes(filter)) continue;
  cases.push(c); results.push(r);
}
const { rows } = analyze(cases, results, { size: report.size });
for (const r of rows) {
  const stmt = (r.failingStatement ?? '(no position)').replace(/\s+/g, ' ').slice(0, 110);
  console.log(`${r.corpus}/${r.id}  [${r.status}${r.message ? ': ' + r.message.slice(0, 40) : ''}] ${r.usesTs ? 'TS' : 'JS'}\n    ${stmt}`);
}
console.log(`${rows.length} failures`);
