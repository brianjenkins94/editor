import { treeParse, streamParse } from 'bablr';
import { m } from '@bablr/helpers/grammar';
import { printSource, printPrettyCSTML } from '@bablr/agast-helpers/tree';
import { printSource as streamPrintSource, evaluateReturn } from '@bablr/agast-helpers/stream';
import { readFileSync } from 'node:fs';
const { default: TypeScript } = await import(new URL(process.env.GRAMMAR ?? '../lib/grammar.js', import.meta.url).href);
import { parseTagType, parseTag } from '@bablr/agast-helpers/tree';
import { LiteralTag, OpenNodeTag } from '@bablr/agast-helpers/symbols';

let src = process.argv[2] ?? 'const x = 1';
if (src.startsWith('@')) src = readFileSync(src.slice(1), 'utf8');
const prod = process.argv[3] ?? 'Program';
const matcher = prod === 'Expression' ? m`<Expression />` : prod === 'Statement' ? m`<Statement />` : m`<Program />`;
const t0 = performance.now();
try {
  const tree = treeParse(TypeScript, matcher, src);
  const out = printSource(tree);
  console.log(`[tree] equal=${out === src} ${(performance.now()-t0).toFixed(0)}ms len=${src.length}` + (out === src ? '' : ` out=${JSON.stringify(out).slice(0,200)}`));
  if (process.env.SHOW) console.log(printPrettyCSTML(tree));
} catch (e) {
  if (process.env.PREFIX) {
    let text = '';
    try { for (const tag of streamParse(TypeScript, matcher, src)) { const t = parseTagType(tag); if (t === LiteralTag) text += parseTag(tag).value; else if (t === OpenNodeTag) { const lv = parseTag(tag).value.literalValue; if (lv) text += lv; } } } catch {}
    const pos = text.length; const line = src.slice(0, pos).split('\n').length;
    console.log(`[prefix] consumed ${pos} chars (line ${line}): …${JSON.stringify(src.slice(Math.max(0, pos - 80), pos))} ⟨⟩ ${JSON.stringify(src.slice(pos, pos + 120))}`);
  }
  console.log(`[tree] ERROR ${(performance.now()-t0).toFixed(0)}ms ${String(e.message).split('\n')[0]}`);
  if (process.env.STACK) console.log(e.stack);
}
if (process.env.STREAM) {
  try {
    const tags = streamParse(TypeScript, matcher, src);
    const out = evaluateReturn(streamPrintSource(tags));
    console.log(`[stream] equal=${out === src} out=${JSON.stringify(out).slice(0,200)}`);
  } catch (e) {
    console.log(`[stream] ERROR ${String(e.message).split('\n')[0]}`);
  }
}
