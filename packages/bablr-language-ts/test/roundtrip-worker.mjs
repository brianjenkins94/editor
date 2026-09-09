// One round-trip check per message: parse with the grammar, print the source back, compare byte-for-byte.
// On failure, re-run as a stream and count the literal text emitted before the VM gave up, so the main thread
// can locate the failing construct.
import { parentPort } from 'node:worker_threads';
import { treeParse, streamParse } from 'bablr';
import { m } from '@bablr/helpers/grammar';
import { printSource, parseTagType, parseTag } from '@bablr/agast-helpers/tree';
import { LiteralTag, OpenNodeTag } from '@bablr/agast-helpers/symbols';
// GRAMMAR=<path> (relative to this file) swaps the grammar under test, e.g. a frozen snapshot for A/B runs.
const { default: TypeScript } = await import(new URL(process.env.GRAMMAR ?? '../lib/grammar.js', import.meta.url).href);

const matcher = m`<Program />`;

const firstDiff = (a, b) => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) return i;
  return n;
};

const consumedPrefix = (source) => {
  let text = '';
  try {
    for (const tag of streamParse(TypeScript, matcher, source)) {
      const type = parseTagType(tag);
      if (type === LiteralTag) text += parseTag(tag).value;
      else if (type === OpenNodeTag) {
        const { literalValue } = parseTag(tag).value;
        if (literalValue) text += literalValue;
      }
    }
  } catch {
    // expected: same failure as the tree parse
  }
  return text;
};

parentPort.on('message', ({ seq, source }) => {
  const t0 = performance.now();
  let result;
  try {
    const tree = treeParse(TypeScript, matcher, source);
    const out = printSource(tree);
    result = out === source ? { status: 'pass' } : { status: 'mismatch', pos: firstDiff(source, out), outLength: out.length };
  } catch (e) {
    const prefix = consumedPrefix(source);
    result = {
      status: 'error',
      message: String(e?.message ?? e).split('\n')[0],
      pos: source.startsWith(prefix) ? prefix.length : null,
      prefixDiverged: !source.startsWith(prefix),
    };
  }
  parentPort.postMessage({ seq, ms: Math.round(performance.now() - t0), ...result });
});
