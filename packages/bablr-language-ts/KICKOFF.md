# @brianjenkins94/bablr-language-ts — new-session kickoff

You're building **our own BABLR grammar for modern TypeScript** — a lossless, annotatable CSTML tree over the
TS code we care about. Self-contained brief; read it fully before starting.

## Approach: extend esnext, write only the TS layer (proven)

BABLR (github.com/bablr-lang) is a parser framework: grammars are generator classes yielding `eat`/`match`
instructions; a VM produces **CSTML** — a concrete syntax tree with the source text embedded, so it round-trips
to the exact input. Grammars **compose by class inheritance**: there's a layered modern-JS stack
`es5 → es6 → es2016…es2021 → esnext`, each extending the last.

**Verified:** `class TypeScript extends ESNext {}` inherits every esnext production and parses modern JS (arrow
functions, `const`, template literals, classes, modules, destructuring — the hard cores) out of the box. So the
plan is: **extend `@bablr/language-en-esnext` and add only the *erasable-TS layer*** (type annotations,
`interface`/`type`/`enum`, generics, `as`/`satisfies`, `declare`). We do **not** rewrite JS. `lib/grammar.js`
already does this — it inherits esnext wholesale today (parses all modern JS losslessly; refuses TS syntax — that
syntax is the layer to build).

### extend vs. fork — an open decision

The creator is anti-AI, so a *live dependency* on the upstream grammars is a liability. Two paths:

- **(A) Extend esnext (current):** declare it a dependency and subclass it. Least work, JS core inherited, proven.
- **(B) Fork the `es5→esnext` chain and own it (no inheritance):** vendor the source (es5/es6/json are devDeps
  here precisely as fork sources), maintain it ourselves, zero live upstream dependency. More maintenance, full
  control.

**Evaluate (A) first** — how powerful/complete the layering actually is (esnext is 0.4.1; it may be incomplete or
buggy for the full surface). Switch to (B) if the upstream limits or the creator-dependency bite. Either way we
**own the TS layer**; (B) additionally owns the JS base. Keep the code structured so the base is swappable
(extend a single imported `ESNext` — forking = repoint that import at vendored source).

## What this is for

Code-as-text-lines makes annotations fragile (line/offset drift on every edit). A lossless annotatable **tree**
is the substrate the capability IDE needs (see `../lib` memory `capability-ide-vision`): annotations anchor to
nodes, the IDE projects the relevant view, and the tree recovers when text changes. This grammar produces that
tree. **`../tsval` (tsc-AST + types) stays the semantics/execution engine**; this CST is the document/annotation
substrate. Text is authoritative; both are projections of it, aligned by **source span** — that alignment (in
`../lib`) is how a BABLR node gets its types/behavior and how annotations re-anchor after an edit.

## The seed (already works)

`lib/grammar.js` = `class TypeScript extends ESNext` — it inherits esnext and parses **all modern JS losslessly
today** (proven). The loop:

```sh
npm install
node run.mjs Program 'const f = (x) => x + 1'                 # modern JS, round-trips
echo 'class A { m() { return `hi ${1}`; } }' | node run.mjs Program
```

`run.mjs` handles the CLI's path quirk and suppresses the one **benign** `Parser failed to consume input` the VM
throws *after* the complete tree (real errors still surface). BABLR is early (0.x) — versions pinned; keep them
pinned. The **TS layer is what's missing**: `const x: string = 1` is refused today — building that is the job.

## The target: exactly tsval's supported surface

Do **not** aim at "all of TypeScript." The target is the language `../tsval` interprets — read its README
"Supported surface": strict-mode **modern ES + erasable TS + `enum`**; explicitly OUT: `namespace`, legacy/TC39
decorators, parameter properties, `with`, sloppy mode. Keeping grammar target === interpreter surface means the
two share one language definition and never drift.

## The oracle: round-trip, driven by tsval's corpus

CSTML embeds the source, so **parse(src) → serialize → must equal src** is a free differential oracle. Build a
harness (`test/`) that reads programs, parses each, re-serializes, and asserts byte-equality. Feed it `../tsval`'s
corpus (its test262 subset + TypeScript `tests/cases` it already vendors) filtered to the supported surface.
Grow the grammar by: run corpus → bucket the failures by construct → implement → re-green. (Same discipline that
took tsval to ~99.9%.)

## Authoring model (from the seed + the JSON grammar)

A class of generator `*Production()` methods yielding over the `m\`\`` template DSL:
- `<Prod />` invoke a production; `<_Prod />` its trivia-wrapped variant; `<* 'lit' />` a literal token;
  `<*Token /regex/ />` a regex token; bare `/regex/` an inline match.
- field binders: `name$:` (node field), `tok*:` (token field), `arr[]$:` (array field), `#:` (trivia/separator).
- `eat` (consume-or-fail), `match` (lookahead), `eatMatch` (optional); `startSpan`/`endSpan` for string
  contexts; `defineAttribute('cooked', …)` for computed values; tokens from `@bablr/helpers/productions`.

## Staged plan (JS is inherited from esnext — these stages are the TS layer)

- **S0** — round-trip harness over tsval's corpus, run against the bare `extends ESNext` seed to **measure how
  complete/correct esnext's modern-JS coverage actually is** (this *is* the "evaluate the layering power" step
  that informs extend-vs-fork). Bucket failures by construct.
- **S1** — **Type annotations**: override `VariableDeclarator`, function/method params, and function return
  positions to `eatMatch` an optional `: <TypeAnnotation />`; add `*TypeAnnotation`/`*TypeReference` (`string`,
  `Foo`, `Foo<T>`, `T[]`, unions, literals, `() => T`).
- **S2** — **Type declarations**: `interface`, `type` aliases, `declare` — hook into the inherited `Statement`
  dispatch; kept as CST nodes tsval erases.
- **S3** — **Generics + expression-level TS**: type parameters on functions/classes, `as`/`satisfies`, non-null
  `!`, `import type`/`export type`.
- **S4** — **`enum`** (runtime-emit; matches tsval's one retained non-erasable construct).
- **S5** — round-trip green on tsval's corpus; **make the extend-vs-fork call** from what S0–S4 revealed; then
  hand off to the **CST ↔ tsc span-alignment** bridge in `../lib` (types/execution + annotation anchoring).

## Working style

- **Round-trip first**: every construct must reproduce its exact input before you move on.
- **Grow against the corpus**: fail loudly on an unimplemented construct, then close the gap.
- **Own it**: es5/JSON grammars are *references* to read and re-express, never dependencies.
- **Target === tsval's surface**: don't diverge; if tsval doesn't run it, don't grammar it (yet).
- Append decisions/state to `PROGRESS.md` so the next session inherits them.

## Surroundings

- `./lib/grammar.js`, `./run.mjs` — the seed + the loop.
- `../tsval` — the interpreter whose supported surface is your target and whose corpus is your oracle input.
- `../lib/util/silo` — the capability layer that will annotate this CST (later; via span-alignment).
- devDeps `@bablr/language-en-es5` (JS-core reference), `@bablr/language-en-json` (simplest complete example).

## First move

`npm install`, confirm `node run.mjs Statement 'const x = "https://a"'` round-trips, then **S0**: stand up the
round-trip harness and point it at a dozen supported-surface snippets; then start **S1** (expressions).
