# PROGRESS — @brianjenkins94/bablr-language-ts

Append-only log of state and decisions. Newest at the bottom. See KICKOFF.md for the brief.

## 2026-09-05 — S0: round-trip harness + measurement of the bare `extends ESNext` seed

### Harness (test/)
- `test/roundtrip.mjs` — round-trip oracle: `treeParse(src)` → `printSource` → byte-equal. Worker pool
  (`test/roundtrip-worker.mjs`), per-case timeout, `--corpus ts-cases|test262|all`, `--full`, `--filter`,
  `--limit`, `--jobs`, `--fast`, `--out`. `GRAMMAR=<path>` env swaps the grammar under test (A/B runs).
- `test/corpus.mjs` — imports **tsval's own loaders and `policySkip` filters** (TS source, Node strips types),
  so eligible-here === eligible-for-tsval by construction. Sample roots are what tsval checks in
  (584 ts-cases, 630 test262 + 32 harness files); `--full` uses its fetched pinned checkouts (~21k).
- `test/classify.mjs` + `test/analyze.mjs` — TypeScript is used as a *labeler only* (never the oracle):
  `usesTsSyntax` splits pure-JS cases from TS-using ones; on failure, the consumed prefix (literal text the
  stream emitted before the VM gave up) locates the failing top-level statement, and a **feature census** of that
  statement is ranked against features seen in passing cases → a suspect list by construct. Also a TS-feature
  census (what the TS layer must cover, by frequency). `node test/analyze.mjs <report.json>` re-analyzes a run.
- Position caveat: the VM only commits a statement's text when it completes, so "position" is coarse (start of
  the failing statement or sub-node). The feature census compensates.
- `test/probe.mjs 'src' [Production]` — single-snippet round-trip (`SHOW=1` prints the CSTML). Note the CLI's
  pretty printer duplicates the last digit of integer tokens (`1` prints as `'11'`); the tree is correct.

### Results: seed grammar (esnext 0.4.1 inherited wholesale), sample corpora (1246 cases, ~20s)
| corpus | cases | pass | pass% |
|---|---|---|---|
| test262 (pure JS) | 630 | 243 | 38.6% |
| test262 harness (pure JS) | 32 | 20 | 62.5% |
| ts-cases, pure JS | 212 | 110 | 51.9% |
| ts-cases, uses TS syntax | 372 | 0 | 0% (expected: TS layer not built yet) |

No mismatches and no timeouts: every failure is a refusal (`Parser failed to consume input`, `rejected root
state`) or an internal VM assertion. When BABLR accepts a program, it round-trips exactly.

Top pure-JS gaps in esnext (fails / never seen in a passing case): private names `#x` (122), async generator
methods (62), `\u` escapes in identifiers (46), non-ASCII identifiers (43), object-literal `get`/`set` (38),
class fields without initializer (38), leading BOM (30), bare `yield` (20), `;` class members (18),
bare-param arrows `x => x` (12), destructuring in `for` heads (~29), regex literals in some positions (9),
destructuring assignment (9), BigInt (9), exponent/hex/leading-dot numerics, rest params, spread calls, async
arrows, `>>>`, `**`, `&&=`/`??=`, `new.target`, unicode whitespace. Also: `arguments`/`eval`/`await` are in
es5's *reserved* list so `var x = arguments[0]` is refused; class field `a = arguments` trips a VM assertion.

### Performance
~1–2 KB/s per core (4.9 KB `assert.js` = 2.7 s). CPU profile: `@bablr/record` `validate` walk 30%,
`freezeRecord` (setPrototypeOf(null)+freeze) 10%, btree 21%. Experiments (test/nofreeze.mjs,
test/fast-record*.mjs, opt-in via `--fast`): skipping the validation walk = −27%; also making `Object.freeze` a
no-op = −37% total; **output byte-identical, 0 status diffs on all 1246 cases**. Removing the
`setPrototypeOf(null)` too is NOT possible without forking the runtime: `@bablr/btree` asserts null prototypes.

### Evidence for extend-vs-fork (decision deferred to S5 per KICKOFF)
- Layering works mechanically (subclass + triviaEnhancer), but esnext 0.4.1 is far from complete: ~40–50% of
  in-surface pure-JS programs are refused, across many constructs (list above). Closing them means overriding a
  large share of esnext's productions anyway — those overrides are identical code whether they live in our
  subclass (A) or in a vendored base (B).
- The runtime's hardening (record validation, freezing, null prototypes) costs ~40% and some of it is only
  removable by forking runtime packages, not just grammars.
- Structural rule kept: everything extends one imported base (`ESNext`), so forking = repointing that import.

### Decisions
- Corpus eligibility is tsval's `policySkip`, imported, never re-implemented here.
- `typescript@5.9.3` (tsval's pinned version) is a devDependency for the harness labeler only.
- JS gaps that are inside tsval's surface (e.g. private names, object accessors, `arguments`) are ours to close
  too, in `lib/grammar.js`, regardless of the extend/fork outcome.
- Next: S1 type annotations (census: `Type@Parameter` 198, `TypeReference` 193, `Type@VariableDeclaration` 163,
  `TypeParameter` 105, `InterfaceDeclaration` 101, `TypeLiteral`/`PropertySignature` 99, `ArrayType` 64,
  `TypeArgs` 57, `FunctionType` 48, `UnionType` 46).

## 2026-09-05 — S1 (type annotations) + S2 (declarations, classes) landed

### Grammar structure (lib/grammar.js) — how to extend the base, learned the hard way
- Productions live on `TypeScriptAtrivial extends ESNext.atrivial`; the default export is
  `enhance(TypeScriptAtrivial)` (the same `triviaEnhancer` wrapper every es-layer uses). A plain
  `class X extends ESNext {}` only works while it adds no productions.
- Covers (`<_Name />`) may not own fields and may only shift by RETURNING `r(shiftMatch(...))`; fields whose
  matcher is a cover need `+` (`type+$: <_Type />`). Infix/postfix forms shift like `Expression`/`LogicExpression`.
- Upstream productions are extended by INTERCEPTION (`intercept(super.X(args), { first, before, after, replace })`
  forwards each instruction and injects ours around named fields) — return types, type parameters, optional bodies
  ride on the inherited function productions without copying them.
- The m`` DSL: a regex may contain `<` in any spelling (verified with test/rx.mjs) but `\x` escapes are not
  supported; `\u` is the DSL's own escape (so a literal `\u` in source text is written `\\u`). Module-level
  matchers built from strings use `mRaw(source)`. A keyword needs a delimiter after it (es3 `Keyword`); we add
  `<`/`>` so `class<T>` and `extends B<T>` parse.
- A class body with two methods of the same name silently keeps the LAST one — cost an hour (stale S1 `ClassMethod`
  interception shadowed the S2 production). `node -e` duplicate check is now part of the workflow.
- Diagnosis tools: `test/probe.mjs` (one snippet, `SHOW=1` for the tree), `test/probe-all.mjs <file>` (batteries:
  test/cases-s1.txt, -s2, -s3), `test/rx.mjs` (regex-VM probe), `test/variant*.mjs` (bisect a production by
  composing it from pieces on a subclass without touching the grammar).

### What the TS layer covers now
- Annotations: variable declarators (incl. array patterns), parameters (`Parameter` node: pattern, `?`, type, then
  the base's `AssignmentPattern` default), rest params, `this` params, return types and type parameters on
  functions / arrows / methods / class methods, class fields (`x: T`, `x?: T`, `x!: T`, no initializer, no `;`).
- Types: keywords, references with qualified names + type args, literals, arrays, tuples (named/optional/rest),
  unions/intersections with precedence, `keyof`/`readonly`/`unique`, `typeof`, indexed access, parenthesized,
  function/constructor types, type literals (property/method/index/call/construct signatures), type parameters
  with constraints/defaults/`const`/`in`/`out`.
- Declarations: `interface` (extends list), `type` aliases, `enum`/`const enum`, `declare …` (ambient; bodies
  optional), `abstract class`, function/method overloads (bodiless), class `implements`, generics on class
  heritage, accessibility/`readonly`/`abstract`/`override`/`declare` modifiers, private names (`#x` members,
  `o.#x`, `#x in o`), `static` blocks, getters/setters (class and object literal), `;` class members, class index
  signatures, string/numeric/computed member names, generic object methods.
- JS gaps closed in passing: object-literal accessors, generic arrows, async arrows, bare-param arrows,
  `async function` expressions, bare `yield`, destructuring assignment targets, unicode/escaped identifiers,
  `arguments`/`eval` as identifiers, leading BOM, numeric literals (radix, separators, `.5`, `1.`, exponent,
  BigInt), class fields without initializers, async generator methods, `class<T>` expressions.

### Measurements (sample corpora, 1246 cases, `--fast`)
| stage | test262 JS | ts-cases JS | ts-cases TS |
|---|---|---|---|
| S0 seed (esnext as-is) | 38.6% | 51.9% | 0% |
| S1 annotations | 42.5% | 56.1% | 21.0% |
| S2 classes + declarations | 58.1% | 62.3% | 67.5% |

### Known gaps queued (from the census)
- Operator layer (upstream bug + missing ops): `<<`, `>>`, `>>>`, `<<=` fail because es3's operator regex lists `<`
  before `<<` (alternation order); `**`, `??`, `&&=`/`||=`/`??=`, `**=` are absent. Fix = own LogicExpression /
  BinaryExpression / AssignmentExpression (the first real "fork" of an expression layer), which also hosts the
  TS expression forms: `as`, `satisfies`, non-null `!`, `<T>x`, call/new type arguments, spread in calls.
- Types: conditional/infer, mapped types, type predicates (`x is T`, `asserts x`), template literal types.
- Regex literals with a space or `\u{…}`+`u` flag (base's regex sub-language); unicode whitespace; NEL; `new.target`.
- Not in scope by policy (tsval): namespaces/modules, decorators, parameter properties, `with`.

## 2026-09-05 — S3 (expression-level TS) + JS-gap waves landed

### Added
- Own operator layer (LogicExpression / BinaryExpression / AssignmentExpression / CallExpression / NewExpression /
  MemberExpression): fixes the base's operator alternation order (`1 << 0`, `>>`, `>>>`), adds `**` (right-assoc),
  `??`, `&&=`/`||=`/`??=`/`**=`, optional calls `a?.()`, spread arguments, `new.target`, and the TS forms `as`,
  `as const`, `satisfies`, non-null `x!`, `<T>x`, `f<T>()`, `new C<T>()` (generic calls are attempted only when the
  text looks like `<…>(`: a speculative shift that adopts the held callee cannot be backtracked cleanly).
- Regex literals as one node with body/flags tokens in a trivia-free span (tsc treats a regex as one token too);
  replaces the base's regex sub-language, which rejects flags, spaces, `\/`, groups and `{m,n}`.
- Types: conditional types (+ `infer`), mapped types (`readonly`/`?` modifiers, `as` clause), type predicates
  (`x is T`, `asserts x`, `this is T`), generic and `abstract new` function types, leading `|`/`&`; type argument
  and parameter lists use UNGUARDED spans (a `>`-guarded span ends at the `>` of `() => T`).
- JS: `for` headers with word-boundary guards (the base's `/;|of|in/` guard fires inside `index`/`info`!),
  identifiers carry their own span (an escape like `\u{6F}` inside a `{}` block collided with the block's guard),
  empty statements, `if (a) b; else c`, rest/elision in patterns and literals, spread followed by `,`, numeric
  object keys, all string escapes (`\x`, `\u{}`, identity, line continuation — the base's `EscapeCode` referenced a
  non-existent `Digits` production), destructuring/annotated/optional catch bindings, `{ a = 1 }` cover names,
  `await` as an identifier, block-ending statements followed by another statement on the same line.

### Measurements (sample corpora, 1246 cases, `--fast`)
| stage | test262 JS | ts-cases JS | ts-cases TS |
|---|---|---|---|
| S2 classes + declarations | 58.1% | 62.3% | 67.5% |
| S3 identifiers/numbers/arrows/yield | 78.4% | 80.7% | 76.9% |
| S4 operator layer + regex + TS expressions | 89.4% | 84.4% | 85.5% |
| S5 JS gaps + types wave | 95.6% | 93.4% | 94.9% |

Speed is unchanged vs the seed (assert.js 1.53 s vs 1.62 s with the shims); the 125 s wall time is one stress
case (`parsingDeepParenthensizedExpression.ts`, thousands of nested parens) hitting the 120 s timeout.

### Upstream defects found so far (each worked around in lib/grammar.js; evidence for the fork decision)
operator alternation order; `for` guard without word boundaries; guard-char collisions (`T[]` in tuples, `=>`
in `<…>`, `\u{}` in blocks) needing span workarounds; regex sub-language rejecting basic literals; `EscapeCode`
→ missing `Digits` production; `arguments`/`eval` reserved; array `[...a, b]` never taking its separator; empty
program refused; `ClassMethod` forbidding `async *`; no object accessors, no class fields without initializer,
no bare `yield`, no `**`/`??`/logical assignment, no bare-param or async arrows, no `async function` expressions.

## 2026-09-05 — closing the sample corpus; full-corpus measurement

### Added since the last entry
- Generic calls everywhere (`var r = g<U, V>(1)`): the `<…>(` lookahead is now run inside an unguarded span —
  a regex lookahead under a span guard cannot see past the guard character (`,` of a declarator list), which is
  also why the base's operator regex was blind in places. `?` is excluded from that lookahead so ternaries with
  parenthesized branches never enter the speculative call parse (a failed shift that adopted the callee cannot be
  backtracked; a `match(<Node />)` lookahead is refused while a node is held, so a probe production is not an option).
- `await` as an identifier (script-goal tests; tsc accepts it): the base's dispatch never falls back to Identifier
  for `await`/`yield`; a `$`-aware lookahead (end of guarded input counts as a delimiter) routes it.
- `=>` with no space before its body: es3's `Keyword` demanded a delimiter after every keyword; only word-like
  keywords need one. Arrow functions are not callable/member-accessible (`() => {}` newline `(` starts a new
  statement, as ASI requires). `TypeAssertion` uses an unguarded span (`<() => T>x`).
- Statement dispatch: the base's `/import|export|class|var|const|let|async/` has no `\b`, so `importScripts(…)`
  and `asyncFn(…)` were taken for declarations. A lone tab as trivia was refused (the base's single-whitespace fast
  path eats a literal space). Unicode whitespace (NBSP, LS/PS, BOM, …) is trivia. Empty statements, `if … ; else`,
  block-ending statements followed by another statement on the same line (except the `if (a) {} b()` upstream gap).
- Harness: `test/failures.mjs <report>` lists every failing case with the statement it failed in; the labeler is
  guarded against pathologically deep trees; raw results are written before analysis (an analysis crash cost one
  full-corpus run); `test/probe.mjs` gained `PREFIX=1` (consumed-prefix locator) and `GRAMMAR=` (A/B).

### Sample corpora (1246 cases): 99.5% test262 JS, 93.9% ts-cases JS, 95.7% ts-cases TS
Of the 36 remaining sample failures, 27 are inputs outside the target: parser/error-recovery tests tsc tolerates
(`set foo(a)` without body, `class C extends {`, `async interface`, `{ greet? }`, `interface I implements A`),
sloppy-mode names (`let`, `interface`, `static` as identifiers), parameter properties, `declare module/namespace`,
`with`, modifiers on object-literal members. Real gaps left: astral characters anywhere (runtime), the nested-
parens stress case (timeout), `a ? (b) : c => (d) : e => f` (TS's conditional/arrow return-type disambiguation),
template literal types, `if (a) {} b()` on one line, `for (i = typeof x; ;)` (guard hack inside the init).

### Full corpora (21,628 eligible cases; tsval's policy skips 14,504)
| corpus | cases | pass | error | timeout | pass% |
|---|---|---|---|---|---|
| test262 (pure JS) | 15,759 | 15,661 | 94 | 4 | 99.4% |
| test262 harness | 32 | 31 | 1 | 0 | 96.9% |
| ts-cases, pure JS | 1,962 | 1,841 | 117 | 4 | 93.8% |
| ts-cases, uses TS | 3,875 | 3,678 | 196 | 1 | 94.9% |

No mismatches anywhere: every accepted program round-trips byte-for-byte; every failure is a refusal. Failure
kinds: 158 "failed to consume input", 156 "rejected root state", 69 partial parses, 10 astral-character literal
failures (runtime), 9 timeouts (all stress files: 40–140 KB binder/control-flow stress cases, four 100 KB+
escaped-identifier tables, the nested-parens case), 4 span-closing errors, 1 hold error. The run takes ~21 min on
12 workers with the `--fast` shims (`test/reports/full.json`; re-analyze with
`node --stack-size=7000 test/analyze.mjs test/reports/full.json` — the labeler's recursive walks overflow the
default stack on the stress cases).

### Where this leaves the extend-vs-fork call (S5)
- The grammar side is effectively forked already: this file owns expressions/operators/calls/members, statements
  (list, for, if, catch), classes, identifiers, numbers, strings/escapes, regex literals, trivia and the whole TS
  layer; the base contributes JSON literals, templates, imports/exports, blocks/switch/try, patterns and the
  cover/shift/trivia machinery. Repointing the single `ESNext` import at vendored source is a mechanical step.
- The live dependency that actually bites is the RUNTIME (bablr-vm, regex-vm, agast-helpers, btree): astral
  characters break every literal (emoji in a comment kills a file), empty programs are refused, span guards are
  anchored (three workarounds in this grammar), speculative shifts cannot be backtracked, and ~40% of parse time is
  invariant checking that only a runtime fork can remove. Recommendation for the user's decision: fork the grammar
  chain now (cheap, closes the authorship question) and plan a runtime fork or upstream fixes for the astral bug,
  which is the one defect no grammar can route around.


Full-run census (what the failing statements contain that no passing case has): `declare module/namespace` (40,
out of policy), template literal types (19 — the one real TS gap left), `with` (10, out of policy), `let x!: T`
(4, added afterwards), empty files (10, runtime), hashbang (1, added afterwards), JSDoc `?T`/`!T` types and
`{ a? }` shorthand (invalid TS). Everything else in the residue is a JS construct that also appears in thousands of
passing cases (comments, CRLF, `var`, classes), i.e. the failing files are failing for the reasons above or for
inputs outside the target, not for a missing construct.

### Follow-up landed the same day
- Template literal types (`\`get${P}\``; es6's template string content with types in the holes).
- `if (a) {} b()` / `while (a) {} b()` / `for (;;) {} b()` on one line: If/For/While record an `endsWithBlock`
  attribute (declared in the grammar constructor like es3's UnaryExpression `position`) and the statement list
  reads it — the base's lookup through the consequent's gap node never resolves to the Block. Invalid forms
  (`if (a) b c()`) are still refused. Sample corpora: 99.7% / 94.3% / 95.7%.
- Also: `let x!: T`, hashbang lines. Harness note: a background wait loop must not test `pgrep -f <pattern>`
  where the pattern matches the loop's own command line (five such loops idled until killed).

### Next
- `for (i = typeof x; ;)` (guard hack inside an expression init); astral characters (runtime).
- The fork decision (recommendation above), then the CST ↔ tsc span-alignment bridge in ../lib.
- Keep `node test/roundtrip.mjs --fast` (sample, ~2 min) as the regression gate; the full run is ~21 min.

### Runtime workarounds are tagged (full write-up: UPSTREAM_BUGS.md)
Every place the grammar bends around a RUNTIME defect (not a language need) is marked `UPSTREAM-WORKAROUND(Wn)`
in lib/grammar.js (11 sites, W1–W4) and in test/fast-record.mjs / test/nofreeze.mjs (W5); the file header holds
the index with the upstream change each one waits for, plus the two unaddressed defects (U1 astral characters,
U2 empty input). `grep -n UPSTREAM-WORKAROUND lib/grammar.js test/*.mjs` lists them.
