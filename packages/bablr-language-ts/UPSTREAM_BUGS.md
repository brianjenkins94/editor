# Upstream defects found while building @brianjenkins94/bablr-language-ts

Self-contained brief for a session that wants to fix these upstream, vendor and patch the packages, or decide the
extend-vs-fork question. Everything here was reproduced against the UNMODIFIED upstream grammars ("the seed":
`class TypeScript extends ESNext {}`, kept at `test/reports/seed-grammar.js` when present) and the pinned runtime
below. Repro lines run from this repo: `GRAMMAR=<path> node test/probe.mjs '<source>'` parses with a given
grammar file (default `../lib/grammar.js` relative to test/); `PREFIX=1` prints how far the stream got before the
VM gave up; `SHOW=1` prints the CSTML. `node test/rx.mjs '/re/' 'input'` tests a DSL regex in isolation.

**Status (2026-09-06):** Four local patches remain (`patches/`): U1 (two packages), U2, and the record perf
opt-out. They apply only in this repo — anyone installing the published grammar gets stock packages — so the
grammar is verified on stock packages too and loses exactly the U1/U2 inputs there. A boundary-guard patch for
W1–W3 was tried on 2026-09-05 and dropped on 2026-09-06 after the maintainer's review: it redefined a primitive
whose intended semantics are not documented anywhere, and the grammar's original span workarounds are the
pattern the base grammars themselves use. W4 is closed in the grammar (it was W6, a committed node literal, nested
in the speculative call). The CLI digit-duplication item could not be reproduced. `\xNN` in DSL regexes is a real
lexer bug we do not patch because the grammar never uses `\x`.

Terminology: a **span** is the VM's lexical region with an optional **guard** (a string/regex at which `$` matches);
a **cover** (`<_X />`) is a production whose eaten node stands in its place; a **held** node is the just-parsed node
awaiting a possible **shift** into an infix/postfix form.

## Pinned versions (package.json; keep pinned)

| package | version | | package | version |
|---|---|---|---|---|
| bablr | 0.12.6 | | @bablr/agast-helpers | 0.11.4 |
| @bablr/bablr-vm | 0.24.6 | | @bablr/agast-vm-helpers | 0.11.4 |
| @bablr/bablr-vm-strategy-parse | 0.12.4 | | @bablr/regex-vm | 1.0.4 |
| @bablr/agast-vm | 0.12.4 | | @bablr/pattern-engine | 0.3.0 |
| @bablr/btree | 1.0.0 | | @bablr/record | 1.0.0 |
| @bablr/helpers | 0.26.5 | | @bablr/cli | 0.12.5 |
| @bablr/language-en-es3/es5/es6/esnext | 0.4.1 | | @bablr/language-en-blank-space, -c-comments | 0.11.2 |

Paths below are under `node_modules/@bablr/`.

## Part 1 — Runtime (no grammar can fix these)

Sites in our grammar that bend around them are tagged `UPSTREAM-WORKAROUND(Wn)`; the header of
`lib/grammar.js` holds the index. `grep -n UPSTREAM-WORKAROUND lib/grammar.js test/*.mjs`.

### U1. Any astral character (U+10000 and above) anywhere fails — ROOT-CAUSED, patched via patch-package
- Repro (seed and ours): `node test/probe.mjs 'x = 1 // 😀'` → `Failed to advance literal`. Same for strings,
  template literals, regex literals, identifiers (`var 𑈿;`). BMP non-ASCII (`ünïcödé`, `℘`, Arabic digits) works.
- Where it throws: `bablr-vm/lib/evaluate.js:270` and `:344` (`Failed to advance literal`), i.e. a string/regex
  match succeeded but the source could not be advanced by the reported length.
- Confirmed cause, two layers (instrumenting `State.guardedMatch` shows both):
  1. `regex-vm/lib/internal/regex.js:45` builds the matched text with `String.fromCharCode(value)` although `value`
     came from `codePointAt(0)` (`literals.js:4`). Code points above U+FFFF are truncated to 16 bits: U+1F600 becomes
     U+F600 (a private-use char), so the regex `/.*/s` over `" 😀"` yields the literal `" \uF600"`. The VM then
     re-matches that literal against the source as a string (`evaluate.js:262`), which fails → `Failed to advance
     literal`. The message is misleading: nothing was advanced; the second match of the corrupted literal failed.
     Same truncation in `literals.js:64` and `:83` (ignore-case testers).
  2. With (1) fixed, the unit mismatch this note originally suspected surfaces: `getSourceLength`
     (`bablr-vm/lib/evaluate.js:103`) counts UTF-16 units (`" 😀".length === 3`) while `Source.advance(n)`
     (`source.js:146`) steps `n` iterated items and a string iterates by code point (2 items) → `cannot advance a
     source that is done`. Counting code points in `getSourceLength` fixes it. The runtime's unit is therefore the
     code point (regex-vm already compares code points); do not switch the source to UTF-16 units.
- Verified: with the patch, `x = 1 // 😀`, `x = "😀"`, template literals, `/😀/u` and multi-line inputs round-trip
  on the seed and on ours; `node test/rx.mjs '/./' '😀'` passes; the snippet batteries stay 135/135 and the
  `--fast` sample has 0 status changes and 1 gain (`test262-harness/testIntl.js`).
- Left over after the patch: (a) a raw astral char inside a DSL pattern (`/😀/`) still fails to parse because the DSL
  regex lexer indexes the pattern by UTF-16 unit; write `\u{1F600}` instead (works). (b) Astral IDENTIFIERS (`var 𑈿;`) needed a grammar
  change on top of the runtime patch: our Identifier class was BMP-only and its surrogate-pair alternative could never
  match (the source never yields lone surrogates). Fixed 2026-09-05: the class now includes a `\u{10000}-\u{10FFFF}`
  range (`lib/grammar.js`, `astralIdChars`), which the DSL accepts inside `[...]`.
- Impact: 10 files in tsval's full corpora (test262 Intl harness, identifier tables); any real-world file with an
  emoji in a comment.
- Upstream fix (in the patch): `fromCharCode` → `fromCodePoint` at the three regex-vm sites; count code points in
  `getSourceLength`. Add a test with a surrogate pair in a comment, a string and an identifier.

### U2. Empty input is refused — ROOT-CAUSED, patched via patch-package
- Repro (seed and ours): `treeParse(lang, m\`<Program />\`, '')` → `parse failed after 0 characters`
  (`bablr-vm-strategy-parse/lib/evaluate.js:675`). Whitespace-only input parses. `Program` is in `emptyables`.
- Confirmed cause: the strategy's failure test (`bablr-vm-strategy-parse/lib/evaluate.js:650`,
  `!allowEmpty && isEmpty_`) runs for every finished match including the ROOT, and the root is not `Program` but the
  cover wrapper `<_>` that `treeParse` puts around the matcher (name `null`, type `_`). `allowEmpty` is derived from
  `emptyables.has(name)` (`:389`, `match.js:325`), so the nameless root cover can never be emptyable and fails
  whenever the whole tree is empty. Depth-1 `Program` does see `allowEmpty: true`; whitespace-only input passes only
  because the root cover is then non-empty (it holds the Trivia).
- Verified: exempting the root cover from the emptiness check (patch, one line) makes `''` return `<_> _: <Program />
  </>` on both grammars; `printSource` round-trips; batteries 135/135.
- Impact: 10 empty files in the TypeScript corpus (e.g. `compiler/emptyFile.ts`).
- Upstream fix (in the patch): let a cover inherit the covered node's `allowEmpty` (or skip the check at depth 0).

### W1. A token containing the enclosing span's guard character corrupts the parse — worked around (span per token)
- Repro (any grammar): a `]`-guarded span (tuple) containing `T[]`; a `>`-guarded span (type arguments)
  containing `() => T`; a `}`-guarded block containing the identifier escape `\u{6F}`. Symptoms vary: leftover
  held node (`if (s.held) throw new Error()` at `bablr-vm/lib/evaluate.js:160`), `Parser did not close all spans`,
  or `rejected root state` (`bablr-vm/lib/state.js:282`).
- Demonstrated without any language grammar: `node test/guard-probe.mjs` — the token `'a]b'` under a `]`-guarded
  span fails (string and regex forms) while the same token under an unguarded span, or a token without the guard
  char, passes.
- Mechanism: `State.guardedMatch` (`state.js:158`) wraps the source in `GuardedIterator`
  (`bablr-vm/lib/utils/pattern.js:157`), which ends the iterator where the guard matches — INCLUDING mid-token.
  A string/regex match that must consume the guard character sees end-of-input instead. The base grammars only
  survive because their guard characters (`)`, `]`, `}`) never occur inside a token of the base language; TypeScript
  puts `>` inside `=>` and `}` inside `\u{...}`.
- Our workaround (kept): a token that contains an enclosing guard character opens its own span — `Identifier` and
  `PrivateIdentifier` do, the way strings and comments do — and lists whose elements contain such tokens stay
  unguarded with explicit close-token checks (`TupleType`, `TypeArguments`, `TypeParameters`, `TypeAssertion`);
  `ArrayType` eats `[]` as one token. No measurable cost (the private span was timed at parity).
- Tried and dropped (2026-09-05/06): a bablr-vm patch that tested the guard only where a match starts, with a
  `guardMode: 'cut'` span prop to keep the old behaviour for comment content. It passed the corpus with zero
  changes and let the seven sites go, but it was our design of what a guard means, not upstream's — nothing in the
  published packages documents the intent — and `patches/` never reach a consumer, so a grammar that relied on
  it broke on stock packages (tuples with `T[]`, identifier escapes in blocks). Reverted; the maintainer's
  question is filed as draft 05 (repro + question, no proposed change).
- Found while the patch was in: `x = <() => number>null` passed only by accident. The arrow hook tried
  `TypeParameters` at every `<`, and when that failed inside `TypeParameter → Identifier` the inherited arrow
  carried on from INSIDE the failed attempt (W6). The leaked `Identifier` span happened to block trivia before `=>`
  and killed the bogus reading. `typeParametersHook` now only attempts the list when `<` is followed by an
  identifier or a modifier (`typeParametersLookahead`), which fixes it for real.

### W2. Guard regexes are evaluated anchored at the current index (leading `\b` is always true)
- Repro (seed): `for (var p: typeof q; ;) {}` with the base's `/;|of|in/` guard fails; with `/;|\bof\b|\bin\b/`
  it STILL fails inside `typeof` because the guard is tested from the current position, where `\b` before `o`
  holds (no preceding character is visible). Also the base guard fires inside plain names:
  `for (var index = 0; index < 1; index++) {}` → `rejected root state` (see G2).
- Demonstrated by `test/guard-probe.mjs`: guard `/\bof\b/` with token `/\w+/` fails on `typeof` and passes on
  `type`. Mechanism: `wrapSource` (`bablr-vm/lib/utils/pattern.js:16`) feeds the regex engine `''` (or `'\n'`/BOS) as
  the item before the current position instead of the actual previous character, so `\b` at the guard's start is
  always true.
- Mechanism: `wrapSource` (`bablr-vm/lib/utils/pattern.js:16`) feeds the regex engine `''` (or BOS / `'\n'`) as
  the item before the current position instead of the actual previous character, so `\b` at the guard's start is
  always true.
- Our workaround: the `for` init keeps a `/;|\bin\b|\bof\b/` subspan around EXPRESSION inits only (needed because
  the base's `Expression` drops `noIn` when it shifts — G6); declarations use `;` alone. Known wrong refusal:
  `for (i = typeof x; ;)` (never seen in the corpora).
- Upstream fix: evaluate guards with the preceding character available (or offer a token-level guard), and keep
  `noIn` across the shift so no `in`/`of` guard is needed.

### W3. A regex lookahead under a guarded span cannot see past the guard character — no longer exercised
- Repro: with a `,`-guarded declarator subspan, `match(/<[^;]*>[ \t]*\(/)` at `g<U, V>(1)` fails because the
  guarded iterator ends at the first `,`; the same lookahead succeeds in `r = g<U, V>(1)` (no `,` guard).
- Demonstrated by `test/guard-probe.mjs`: `match(/a,b/)` on `a,b` returns null under a `,` guard, non-null unguarded.
- The only site was the regex heuristic for generic calls, which the W4 change replaced with real parsing; no
  lookahead runs under a guard any more. The behaviour itself is unchanged (see `test/guard-probe.mjs`).

### W4. A speculative shift that adopts the held node cannot be backtracked; node lookahead is refused while holding — CLOSED (grammar)
- Repro: in a shifted position, `eatMatch(<CallExpression />)` where the production first eats the held callee
  (`o({ held: 'eat' })`) and then fails leaves the VM in a state that later surfaces as an internal assertion or
  `rejected root state`; `match(<Probe />)` in the same position throws `cannot advance literal while holding`
  (`bablr-vm/lib/evaluate.js:248`/`:330`).
- Resolved 2026-09-05: held-node adoption backtracks FINE. Removing the regex gate showed `eatMatch(<CallExpression />)`
  rolling back cleanly whenever the call failed at its own `(` (`x = a < b && c > d`), and failing only when the
  failure happened INSIDE its `eatMatch(typeArguments$: <TypeArguments '<' />)` — a node literal, which commits
  (W6). The committed inner failure then surfaced as the leftover held node (`evaluate.js:160`) or `rejected root
  state`. With the inner attempt written as `if (match('<')) eat(<TypeArguments />)`, the speculative call
  backtracks, the heuristic is gone, and `f<A | B>(x)`, `f<A extends B ? C : D>(x)`, `a < b > (c)` (generic call,
  as tsc), `a<b>c`, `a < b >> c` all parse. `test/reports/s13-sample.json`: 0 status changes vs s12.
- Still true in the VM: `match(<Node />)` while a node is held throws `cannot advance literal while holding`
  (`evaluate.js:248`/`:330`). No longer needed by us.
- Remaining committed sites in the grammar (`eatMatch(... <TypeParameters '<' />)` after `function f`, `class A`,
  method names, `interface`, `type`; `<TypeArguments '<' />` after `extends B`, `new Foo`, a type name, `typeof x`)
  are positions where a `<` can only start a type list, so the commitment is correct there. Edge left as is:
  `new a < b` (JS reads it as `(new a) < b`) would commit to type arguments.

### W6. A literal on a node matcher COMMITS: `eatMatch(<A '<' />)` is not backtracked if `A` fails after the `<`
- Repro: `node test/backtrack-probe.mjs`. `eatMatch(m\`a$: <A '<' />\`)` where `A` eats `<` and then fails on its
  next token leaves the source past the `<` (`parse failed after 1 characters` when the follower needs the `<`), and
  a `startSpan('Bare', '>')` opened inside `A` stays on the stack (`$` matches at the `<` afterwards). The same
  production without the literal on the matcher (`<A />`) backtracks correctly, whether it fails on its first token
  or two productions deep.
- Where it bit us: the arrow hook's `eatMatch(typeParameters$: <TypeParameters '<' />)`. Every `<` in expression
  position went through it; when the list turned out not to be type parameters (`<() => number>null`), the inherited
  arrow continued from inside the dead attempt. Worked around by `typeParametersLookahead` (only attempt the list
  when `<` is followed by an identifier or a modifier); the old private `Identifier` span had been hiding it.
- Mechanism (confirmed by reading; it is deliberate): the VM matches the node literal first and then creates the
  match WITHOUT a branch when a literal is present — `bablr-vm/lib/evaluate.js:518`
  `if (shouldBranch(effects) && !literalMatcher) s = s.branch()`, mirrored at `match.js:414`; if the literal does
  not match, the match is rejected on the spot (`evaluate.js:534`), and on a later failure `match.js:503` even
  keeps the failed node as the current node. So `eatMatch(<A 'x' />)` means "if the next token is `x`, A MUST
  succeed" — a predicate plus a commitment, not a speculative parse. Authoring rule: never put a literal on an
  `eatMatch`/`shiftMatch` node matcher whose production can fail after that literal; gate with a regex lookahead
  (or use `<A />` without the literal, which branches) instead.
- Upstream: documentation, or a `speculative` option that branches despite the literal.

### W5. Invariant checking costs ~40% of parse time — PATCHED (validation half)
- Re-measured 2026-09-05 on the same file, 3 runs each: plain 2.65 s; validation shim only 1.94 s (−27%);
  no-freeze shim only 2.39 s (−10%); both 1.65 s (−38%).
- Patch (`patches/@bablr+record+1.0.0.patch`): `@bablr/record` skips the `validate` walk unless
  `globalThis[Symbol.for('@bablr/record:strict')]` is truthy when the module loads. The fast path still
  null-prototypes and freezes every record (`freezeRecord`, `deepFreezeRecord` walk to freeze, `isRecord`/
  `isDeepRecord` return true). Production parse of the harness file: 1.98 s (−25%), byte-identical output;
  `test/reports/s14-sample.json` (no shims): 0 status changes vs s13.
- The freeze half cannot be patched the same way: removing `Object.freeze` from the record fast path or from
  `agast-helpers` `freezeRecord` trips `isFrozen` assertions (`agast-helpers/lib/path.js:116` at module load,
  `bablr-vm/lib/evaluate.js:124`, `context.js:74`,`:89`,`:95`,`:101`, `agast-helpers/lib/builders.js:92`,`:1203`,
  `path.js:654`), and `btree/lib/enhanceable.js:22` asserts the null prototype. That last 10% needs upstream to
  drop the assertions or build without them.
- Evidence: CPU profile of parsing test262's `assert.js` (4.9 KB): `@bablr/record` `validate` 30%,
  `agast-helpers/object.js freezeRecord` (`setPrototypeOf(null)` + `freeze`) 10%, `@bablr/btree` 21%. Replacing
  `@bablr/record` with a validation-free copy (`test/fast-record.mjs`, wired by a loader hook) plus a no-op
  `Object.freeze` (`test/nofreeze.mjs`) cuts wall time 37% with byte-identical output and 0 status changes on
  1,246 corpus cases (`--fast` in the harness). Making `freezeRecord` a full no-op is impossible:
  `btree/lib/enhanceable.js:22` throws when a record has a prototype.
- Upstream fix: a production build/flag that skips deep-freeze validation (keep it for tests), and avoid
  `setPrototypeOf` on hot objects (it deoptimizes V8 object shapes; construct null-prototype objects up front).

### Smaller runtime items
- `@bablr/cli` pretty-printer duplicating the last digit of integer tokens: NOT reproducible with cli 0.12.5
  (`echo 'const x = 1' | bablr -l file://…/grammar.js -p Program` prints `'1'`, `12` prints `'12'`, seed and ours).
- The DSL regex lexer (`agast-vm-helpers/lib/parsers/regex.js`) `\x` branch (`:242`) never steps past the `x`
  (the `\u` branch does it with `str[++p.idx]`), so it reads `"x4"` from `\x41` and `String.fromCodePoint(NaN)`
  throws the native `Invalid code point NaN`. One-line fix in the patch; `/\x41/`, `/[\x41-\x5a]+/` then work. `<`/`>` are "special" in Bare regex spans (`isSpecial`,
  `:161`) but any spelling of `<` works in practice (verified with test/rx.mjs), so the base's operator-regex
  failures (G1) are ordering, not escaping.
- Lookahead and lookbehind are unsupported in DSL regexes (explicit throw at `:306`); `\b` is supported.

## Part 2 — Grammars (es3 → esnext); each fixed by an override in lib/grammar.js

Repro lines use the seed grammar: `GRAMMAR=./reports/seed-grammar.js node test/probe.mjs '<src>'`.

| id | defect | repro (seed) | upstream location | our override |
|---|---|---|---|---|
| G1 | operator regex lists `<` before `<<` and `>` before `>>`, so `<<`, `>>`, `>>>`, `<<=` are refused | `let e = 1 << 0` | es3 `mixins/logic.js` `binaryExpressionPowerRank` + `writeRegexGroup` order | own `LogicExpression`/`BinaryExpression`/`AssignmentExpression`, longest-first `operatorMatcher` |
| G2 | `for` init guard `/;|of|in/` has no word boundaries | `for (var index = 0; index < 1; index++) {}` | es6 `grammar.js:227` | own `For` (see W2) |
| G3 | statement dispatch `/import|export|class|var|const|let|async/` has no `\b` | `importScripts("")`, `asyncFn(1).then(x => x)` | es6 `grammar.js:178` | `Statement` routes keyword-prefixed names to `ExpressionStatement` |
| G4 | `arguments` and `eval` are reserved words | `var x = arguments[0]`; class field `a = arguments` trips a VM assertion | es5 `grammar.js:57`,`:71` | own `Identifier` with the strict-mode/module list |
| G5 | `await`/`yield` dispatch never falls back to Identifier | `f(await)`, `var await = 1` | es6 `grammar.js` `Expression` `case 'await'` | `Expression`: `await` + delimiter/`$` → Identifier |
| G6 | `Expression` drops `noIn` on shift | `for (k in o) {}` (only "works" via the G2 guard hack) | es6 `grammar.js` `return r(shiftMatch(m\`<_Expression />\`, o({ power })))` | guard hack in `For` (W2) |
| G7 | trivia fast path assumes a single whitespace char is a space | `x\t=\t1` | every layer's `triviaEnhancer` `Trivia` (`es2022.js:194`) | `enhance()` copy checks `res[0] === ' '` |
| G8 | `Keyword` demands a delimiter after every keyword, including `=>` | `f((n)=>n)` | es3 `grammar.js` `*Keyword` | own `Keyword`: delimiter only after word-like keywords; also allows `<`/`>` (`class<T>`) |
| G9 | `EscapeCode` references a non-existent `Digits` production; identity escapes and line continuations refused | `"\u{0}"`, `"\x19"`, `"\d"`, `"a\<newline>b"` | es3 `mixins/json.js:194`,`:197` | own `EscapeSequence`/`EscapeCode`/`HexDigits`/`LineContinuation` |
| G10 | regex sub-language rejects every flag, spaces, `\/`, `(a)|b`, `{m,n}` | `x = /a/g`, `x = / /` | es3 `regex.js` `FlatPattern` pre-scan + `Flags` | `RegExpLiteral` as one node (body + flags tokens) |
| G11 | `UnsignedInteger` tests `firstDigit.value` on a string (always true) | `01` accepted; harmless for round-trip | es3 `mixins/json.js:214` | own `Number` (also adds radix, separators, `.5`, `1.`, exponent, BigInt) |
| G12 | class methods: `async *` explicitly fails; fields need `= v;`; no `#names`, no `;` members, no accessor/string/numeric names in some positions | `class A { async *g() {} }`, `class A { x: T }`, `class A { #x }` | es2022 `es2022.js:111`, `ClassProperty`; es6 `mixins/class.js:65` | own `ClassMember`/`ClassMethod`/`ClassProperty`/`ClassIndexSignature`/`EmptyMember` |
| G13 | no object-literal accessors, no `{ a = 1 }` cover names, generic methods | `x = { get a() {} }` | es6 `ObjectElement`/`Method` | own `ObjectElement`/`Method`/`CoverInitializedName` |
| G14 | no bare-param, async, or generic arrows; no `async function` expressions | `x => x`, `async x => x`, `x = async function () {}` | es6 `Expression` (`(`-only arrow entry) | `Expression` entries + `intercept` hooks on the inherited arrow |
| G15 | bare `yield` refused | `function* g() { yield }` | es6 `mixins/function.js` `YieldExpression` | own `YieldExpression` |
| G16 | array/object literals are not assignment targets | `[a, b] = c` | es3 logic `assignables` | `static context.assignables` += Array, Object, NonNullExpression |
| G17 | array literal: spread never takes its `,`; no elisions | `[...a, ...b]`, `[,,1]` | es6 `ArrayElement` | own `ArrayElement`/`SpreadElement` (subspan) |
| G18 | array patterns: no rest; object pattern rest parsed as an expression | `const [a, ...b] = c`, `const {a, ...b} = c` | es6 `mixins/function.js` `ArrayPattern`, es2018 `ObjectPattern` | `CapturePattern` handles `...`; own `ObjectPattern` with `SpreadPattern` |
| G19 | catch parameter must be an identifier; no optional binding | `catch ({a}) {}`, `catch {}` | es3 `mixins/statement.js` `Catch` | own `Catch` |
| G20 | no empty statements; `if (a) b; else c` refused; `if (a) {} b()` on one line refused | `while (x);`, `if (a) b; else c` | es3 `StatementList`/`If`/`Statement` (trailing-block lookup through the gap node never resolves) | own `StatementList`/`EmptyStatement`/`If`/`While`/`For` with an `endsWithBlock` attribute |
| G21 | identifiers ASCII-only; no `\u` escapes; BOM refused; no Unicode whitespace; no hashbang | `let ünï = 1`, `x\u{62}`, BOM-prefixed file, NBSP | es3 `Identifier`, `Program`, `Trivia` + blank-space language | own `Identifier`, `Program`, `Trivia`/`UnicodeSpace`, `Hashbang` |
| G22 | `**`, `??`, `&&=`/`||=`/`??=`/`**=`, optional calls, spread arguments, `new.target` missing | `a ** b`, `a ?? b`, `a ??= b`, `f(...a)` | es3 logic tables; es3/es6 `CallExpression`/`NewExpression` | own operator layer, `CallExpression`, `NewExpression`, `MetaProperty` |

Notes for someone patching upstream rather than overriding: G1, G2, G3, G7, G8, G9, G11 are one-line fixes in the
named files; G12–G22 are missing features of the ES2015+ layers. Our overrides are written to be liftable: they
follow the base's field names (`sigilToken*`, `openToken*`, `body$`, `#separatorTokens`) so trees stay compatible.

## Verified runtime patches

APPLIED via patch-package (`patches/`, re-applied by the `postinstall` script on every `npm install`) — in THIS
repo only: the published grammar's consumers get stock packages, so nothing in the grammar may depend on a patch.
One file per concern, in patch-package's sequenced form; the perf change has its own file
(`test/reports/upstream-fixes.patch` is the original U1/U2/`\x` diff as one `-p0` file, kept for reference). Files:

| patch file | fixes |
|---|---|
| `@bablr+regex-vm+1.0.4+001+astral-code-points.patch` | U1 (`fromCodePoint`) |
| `@bablr+bablr-vm+0.24.6+001+astral-source-length.patch` | U1 (code-point `getSourceLength`) |
| `@bablr+bablr-vm-strategy-parse+0.12.4+001+empty-root.patch` | U2 |
| `@bablr+record+1.0.0+001+perf-no-validation.patch` | perf only: W5 validation off (−25%) |

Dropped 2026-09-06: the boundary-guard patch and its memo, the c-comments companion, and the `\x` lexer fix (a real
bug, but the grammar never writes `\x`).

Changes by source location:

| file | change | fixes |
|---|---|---|
| `regex-vm/lib/internal/regex.js:45` | `String.fromCharCode(value)` → `String.fromCodePoint(value)` | U1 |
| `regex-vm/lib/internal/literals.js:64`,`:83` | same, in the ignore-case testers | U1 |
| `bablr-vm/lib/evaluate.js:108` | `getSourceLength` counts code points, not `.length` | U1 |
| `bablr-vm-strategy-parse/lib/evaluate.js:651` | root cover `<_>` exempt from `!allowEmpty && isEmpty_` | U2 |
| `record/lib/index.js` | validation off unless `Symbol.for('@bablr/record:strict')` is set on `globalThis` | W5 (−25%) |

Verification 2026-09-06 with the four remaining patches and the span workarounds back in the grammar
(`test/reports/s15-sample.json`): `npm run test` 138/138; sample corpus identical to `s13` (0 status changes, so the
dropped guard patch had bought nothing on the corpora). On STOCK packages (`s15-stock-sample.json`, no patches, no
shims): `npm run test` 137/138 and 4 corpus cases fewer — the astral-identifier line and `testIntl.js`, two test262
identifier tables and one TypeScript conformance file, all U1. Nothing else differs, which is the guarantee the
published grammar needs.
To measure the unpatched runtime again: `patch -R -p0 -d node_modules/@bablr < test/reports/upstream-fixes.patch`,
then `npx patch-package` to restore.

## Reproduction harness
- `npm run test` — six snippet batteries (`test/cases-s*.txt`), one line per program.
- `node test/roundtrip.mjs --fast` — 1,246-case sample of tsval's corpora (~2 min); `--full` for 21,628 cases
  (~21 min). `GRAMMAR=./reports/seed-grammar.js` measures the unmodified upstream stack (S0 baseline: 38.6% of
  pure-JS test262, 51.9% of pure-JS TypeScript cases, 0% of TS-using cases; current: 99.4% / 93.8% / 94.9%).
- `node test/failures.mjs <report.json>` — every failing case with the statement it failed in.
- `node test/guard-probe.mjs` — W1/W2/W3 demonstrated with a two-production grammar (all OK on the patched runtime).
- `node test/backtrack-probe.mjs` — W6 demonstrated (last three lines fail on the pinned runtime).
- Sweep of the Part 2 repros on 2026-09-05: every G-row fails on the seed and passes on ours except `01` (G11, accepted
  by both) and `const {a, ...b} = c` (G18, accepted by the seed with the wrong tree). Found in passing and fixed the same day: our G14
  override refused statement-level `async` expressions (`async x => x`, `async = 1`, bare `async`) because the base's
  Statement sends every `async` to FunctionDeclaration; `Statement` now routes any `async` that is not `async function`
  to ExpressionStatement (battery line added to `test/cases-s3.txt`).
