# tsval — progress log

Append-only-ish log so the next session inherits decisions + state. Newest stage on top.
See [`ASSIGNMENT.md`](./ASSIGNMENT.md) for the mission and staged plan; this file records what's *done*.

---

## Stepped destructuring + class keys ✅ (2026-09-04) — 99.7%, the structural limitation is gone

**Status:** `npm test` → 1078 tests, all pass, **no known-gap todos left**. Full pinned corpus:
**15,692 pass, 45 fail, 32 inconclusive, 7,957 skipped → 99.7% on eligible** (was 15,619 / 118),
and the run takes 37 s (was 79 s: the timeouts are gone). The 45 are all singletons/pairs.

### The limitation, removed
`yield`/`await` inside a destructuring default, computed key or member target (and a class's
`extends` expression / computed member keys) were evaluated synchronously via `evalNodeSync` and
refused loudly. Now:
- **Patterns compile to a flat list of plain-data ops** (`PatOp`: `eval`, `iter-open/step/skip/
  rest/close`, `obj-open/get/rest/close`, `to-key`, `jump-if-defined`, `name`, `bind`, `assign-id`,
  `member-ref`, `member-store`), compiled once per pattern node (a `PatternProgram` class instance,
  shared by forks) and run by a synthetic **`pattern` frame** whose state — pc, a temp stack, open
  iterator records (with their [[Done]]), open source objects (with used keys) — lives in frame
  fields. A fork/snapshot mid-pattern is an ordinary frame clone (`cloneFrame` deep-clones the plain
  fields). Sub-expressions are pushed as node frames, so a suspension inside them is just a
  suspension. `unwind` closes the frame's open iterators (innermost first) on any signal — a
  generator's `.return()` at a `yield` inside a default IteratorCloses, per spec.
- Used **only for patterns that syntactically contain `yield`/`await`** (outside nested functions);
  the synchronous path stays for everything else. `TSVAL_STEPPED_PATTERNS=1` forces every pattern
  through the stepped machine: **the full corpus gives identical results in both modes** (parity
  check, run for both; `npm test` too). Parameters never need it (a suspension in a parameter
  default is an early error).
- **Class definitions are two-phase**: the `extends` expression and every computed member key
  evaluate on the stepped stack in the class scope (name in TDZ, private names already declared —
  `class C { #f; [this.#f] }` is legal), then the class is built from those values.
- Still synchronous and loudly refused: a catch-clause pattern with a suspension (bound while
  unwinding) — a regression test pins that.

### A fork-isolation bug the new test found
An array iterator inside a frame (for-of, `yield*`, patterns) was a host `ArrayIterator`, which
`fork()` shares — so a fork mid-iteration *starved the original* (each fork's `next()` consumed the
same iterator). `exploreCanary` forks inside `for…of` bodies, so this was real. Now an array whose
iteration is pristine (intrinsic `@@iterator`, untouched `%ArrayIteratorPrototype%.next`) iterates
through a plain cloneable record that reads `length` then the index each step exactly like the
intrinsic (through getters/Proxy traps), with guest-realm result objects. Custom iterators and
generators remain shared (fibers are shared by design).

### Remaining full-corpus failures (45)
Promise-tick interleaving/ordering (9), destructuring/assignment evaluation-order minutiae (4),
`super[super()]`/`new.target` through a plain-function parent/`call-proto-not-ctor` (4), script-goal
leftovers (`var` as a global property, `await` as an identifier: 3), template cooked/raw edge cases
(3), `Cannot destructure` in `for await ([x = 'x' in {}] of …)` (3: TS parses the `in` in a
for-await head differently), class-name inference for static initializers (1), `Subclass.length`
via `arguments` (1), plus a dozen other singletons listed by the report.

---

## test262 round 2 ✅ (2026-09-04) — 99.3% of the eligible language suite

**Status:** `npm test` → 1057 tests: 1054 pass, 0 fail, 3 known-gap todos (sample: 625 pass, 2
inconclusive, 23 policy-skipped of 653). Full pinned corpus: **15,619 pass, 118 fail, 32
inconclusive, 7,957 skipped → 99.3% on eligible** (was 15,328 / 425 / 97.3%). Of the 118: 73 are
the one structural limitation below; the other 45 are singletons across 30 reasons.

### Harness
- test262 tests are *scripts*: the runner passes the realm's global object as the top-level `this`
  (new `VMOptions.thisValue`; default stays `undefined` = module semantics) and the assembled async
  program installs `$DONE` as a global *property* (`asyncHelpers.js` checks
  `hasOwnProperty(globalThis, "$DONE")`; tsval's top-level bindings are not globals by policy).
- Policy skip for `identifiers/*unicode-16/17*` (TypeScript's scanner tables); the 9 `for await`
  destructuring-with-`yield` hangs are listed gaps (they time out rather than fail fast: the
  refusal rejects a `next()` the test never observes).
- The sample tally counts a known gap whether or not it still fails.

### Semantics fixed this round (each differentially verified; several were real bugs, not test262 trivia)
- **A constructor's `return` escaped the construct frame** — `return;` in a constructor returned
  from the *enclosing function*, and a returned object became the program's completion. Now judged
  in `unwind`: an object replaces the instance (a base constructor returning a Proxy is what
  `super()` yields, and fields/private brands go onto *that*), a derived constructor returning a
  primitive is a TypeError, `return` without `super()` is a ReferenceError unless an object was
  returned.
- **`this` TDZ in derived constructors**: `this` (and `super.x`) before `super()` → ReferenceError;
  `super()` runs the parent *then* binds `this` (a second `super()` runs the parent again and throws
  at bind time; fields initialize once); `super()` evaluates to `this`.
- **`super` as a reference**: `super[k]`, `super.x = v` / `super[k] op= v` / `super.x++` (setter
  runs with the instance as receiver, otherwise the property lands on `this`), `super[k]()`,
  `delete super.x` → ReferenceError; the `this` binding is checked before the key expression;
  getters on the parent see the instance (`Reflect.get` with receiver — previously `proto[name]`).
- **Iterator Records**: `next` is read ONCE at GetIterator (for-of, `for await`, `yield*`,
  destructuring); an iterator whose `next`/`done`/`value` throws is marked done so IteratorClose
  is not attempted on it; every result is object-checked.
- Class definition: all member keys evaluated once in source order before any member is defined,
  while the class name is in its TDZ (heritage evaluates in that scope too); a computed instance
  field key is no longer re-evaluated per instance; `static constructor(){}` (TypeScript parses it
  as a static ConstructorDeclaration) is a static method; `extends` requires IsConstructor before
  reading `prototype`, then an object/function/null prototype (`extends Function` works, `extends
  (() => {})` is a TypeError); static field named `prototype` → TypeError; fields are *defined*
  (no inherited setter). The class brand moved from an own property to a WeakMap (it showed up in
  `getOwnPropertyNames`).
- Generators/async: not constructors; a `function*`'s own `.prototype` (inheriting
  %GeneratorPrototype%) is the prototype of its generator objects; `[[Prototype]]` of generator /
  async / async-generator functions is the right intrinsic. In a foreign realm those intrinsics are
  not reachable from the globals, so `VM.realm` builds stand-ins with the right shape and parentage
  (`Realm` type, `makeRealm`).
- Strict `arguments` object (array-like, non-enumerable `length`/`@@iterator`, throwing `callee`),
  also in constructors; indices, array literals, rest arrays and `realmArray` use
  CreateDataProperty (an inherited setter on `Object.prototype[0]` never runs).
- Parenthesized targets `(x) = v`, `(o.p) op= v`, `(x)++`, `for ((x) of …)` (no NamedEvaluation
  through parentheses); `(a.b)()` keeps `this`; `typeof (undeclared)`.
- Object literals: computed keys evaluated in source order interleaved with values; `__proto__:
  null`; an accessor after a data property (and vice versa) replaces it; BigInt literal keys;
  SetFunctionName for methods/accessors (`[Symbol(foo)]` → `"[foo]"`, `get x`/`set x`, string/
  numeric keys); object rest copies own enumerable symbol keys too (was `for…in`: inherited, no
  symbols).
- ToPropertyKey via ToPrimitive (`@@toPrimitive` returning a symbol); `++`/`--` on BigInt;
  private-name targets in destructuring/for-of heads (`for (this.#x of …)` was writing a public
  "#x"); foreign-realm wrapper functions are strict (a host caller's `undefined` receiver reached
  the guest as the realm's global — `"ab".replace("b", f)` saw `this === globalThis`); property
  reads/writes on primitives box in the *guest* realm (`"".constructor === String`); template
  objects' `raw` is non-enumerable; `for (const x = 0; ; x++)` is a TypeError (per-iteration
  copies kept the `let` kind).
- Test suite: `await` inside an object literal's computed key is now modeled (it's on the stepped
  stack); the review-regression test that asserted the loud refusal moved to a default value.

### Remaining full-corpus failures (118)
- **73 — `yield`/`await` inside a synchronously-evaluated sub-expression** (destructuring defaults
  and targets, class computed keys; `evalNodeSync`). Structural; the fix is to evaluate patterns on
  the stepped stack. Everything else is a singleton or a pair:
- Promise-tick fidelity (8): `await` interleaving counts, async-generator return/yield* tick
  ordering, `yield*` not unwrapping promises, async-from-sync `constructor` gets.
- Script-goal leftovers (3): `var` at top level as a global property, `await` as an identifier.
- Ordering minutiae: destructuring target-reference vs source-key order (2), ToPropertyKey before a
  computed key's *value* is evaluated (1), `super[k] = v` deferring ToPropertyKey past the RHS (1),
  `super[super()]` (2), a class expression's inferred name visible to its static initializers (1).
- Template cooked/raw edge cases (3: illegal escapes → `undefined`, CR/CRLF normalization),
  `class extends GeneratorFunction` via code-from-string (1), `new.target` through a plain-function
  parent (1), a few `verifyProperty` attribute shapes.

---

## test262 wired in ✅ (2026-09-04) — 97.3% of the eligible language suite

**Status:** `npm test` → 1056 tests: 1053 pass, 0 fail, 3 known-gap todos. Full pinned corpus
(`npm run test262:report`): **23,726 language tests walked in 75 s — 15,328 pass, 425 fail, 32
inconclusive (Node fails too), 7,941 skipped by policy → 97.3% pass on eligible.** Started the day
at 5,609 pass / 2,931 fail on the first realm-isolated run.

### Harness (`test/differential/test262-*.ts`, `scripts/test262-*.ts`)
- `vendor/test262-sample/` (checked in, ~3 MB): a deterministic 1-in-25 sample of the policy-eligible
  `test/language` tests (653) + harness + LICENSE, run by `npm test`. `vendor/test262/` (gitignored):
  the full checkout, pinned to `419d3e0a`, via `npm run test262:fetch`; `npm run test262:sample`
  regenerates the sample.
- The supported-surface policy is a **metadata filter** (`policySkip`): flags `noStrict`/`module`/
  `raw`, dirs `module-code`/`import`/`eval-code`/`global-code`, parse-phase negatives, host-level
  features (Temporal, Atomics, decorators, …), `$262` users, and `eval`/`Function` users are skipped
  with reasons. Async tests: `$DONE`/`print` are routed to the program's completion promise.
- **Per-test fresh realms on both sides** (`node:vm`). test262 mutates builtins on purpose; the first
  run's 513 identical failures were one test poisoning `Array.prototype[Symbol.iterator]` for every
  later test *and the runner itself*. Node control runs the raw JS strict in a fresh context; tsval
  gets that realm's `globalThis` as its global object (`VMOptions.globalObject`) and creates guest
  values from the realm's intrinsics (`VM.realm`), re-creating its own thrown errors in the guest
  realm (`guestErrors`) so `assert.throws(TypeError, …)` sees the guest's constructor.
- Outcomes are pass / fail / control-failed (inconclusive) / skipped; gaps live in
  `test262-gaps.ts` by id prefix and run as `todo`. The report script buckets failures by
  directory and by normalized reason.

### Interpreter fixes the corpus drove (all differentially verified)
- **A real VM bug:** `step()` silently dropped a pending `throw` when no frame remained (a handler
  that pops itself *before* throwing, e.g. Identifier, inside a sub-evaluation) — every "expected
  ReferenceError from a destructuring default" case.
- Generator/async parameters bound at **call** time (FunctionDeclarationInstantiation), not at the
  first `.next()`; an async *function*'s parameter error rejects its promise instead.
- `.return()`/`.throw()` on a suspended-start generator complete it without running the body.
- **Async generator requests run synchronously** up to the first suspension (a side effect in the
  body is visible right after `.next()`), queued behind an executing request.
- **`yield*` per spec**: forwards `throw`/`return` to the inner iterator (GetMethod semantics; missing
  `throw` → IteratorClose + TypeError; missing `return` → the outer generator returns), object checks,
  awaited inner results in async generators, sync inner results yielded *as-is*. The fiber driver
  routes injected `throw`/`return` to a delegating frame instead of unwinding.
- Destructuring: `null`/`undefined` → TypeError; **IteratorClose** on non-exhaustion and abrupt
  completion (also for `for-of` on break/throw/return, with a non-callable `return` → TypeError);
  assignment targets' *references* evaluated before IteratorStep; ToPropertyKey for computed keys.
- **NamedEvaluation**: anonymous functions/classes take the binding/property/field name (identifier
  and assignment targets, defaults, logical assignment, object literals, class fields, symbols).
- **Private names** (`#x`): per-class-evaluation unique names in a side table (invisible to
  reflection), brand checks on every access, `#x in obj`, private methods/accessors/statics,
  shadowing in nested classes, fork-aware. Previously `#x` was a *public* property named "#x".
- Parameter TDZ (`f(a = a)`), a separate var environment for bodies with non-simple parameters,
  the inner immutable binding of a named function expression, class constructors refuse plain calls,
  a host superclass *creates* `this` (`class E extends RangeError` keeps own `message`), `static`
  methods defined before static initializers run, static private methods/fields.
- `delete`, tagged templates (per-site cached template objects), array holes, `__proto__:` in
  literals (and CreateDataProperty semantics — a computed `["__proto__"]` no longer sets the
  prototype), optional chains short-circuit the *whole* chain (no index/argument evaluation past a
  nullish `?.`), compound assignment evaluates the LHS reference/GetValue before the RHS and logical
  assignments don't evaluate the RHS when decided, `new.target`, `Function.length`/`.name`/
  `.prototype` shapes (arrows/methods have none; foreign-realm function objects), error messages that
  never invoke user `toString`, `arguments`/rest copied by index (never through an overridable
  iterator).

### Remaining full-corpus buckets (425), for the next round
- 59 `yield`/`await` inside a synchronously-evaluated sub-expression (computed key / default /
  destructuring target) — a known structural limitation of `evalNodeSync`.
- 38 `super[expr]` / `super.x = v` (SuperKeyword as a bare expression) — implementable.
- ~52 "expected ReferenceError/TypeError not thrown" and ~30 SameValue/ordering minutiae (property
  attribute shapes via `verifyProperty`, observable get-order in async iteration), 18 tests whose
  `async` flag my frontmatter parser may be missing (`asyncTest called without async flag`), 9 hangs.

---

## Post-S6 review: fixes + the ts-evaluator corpus ✅ (2026-09-04)

An independent review (adversarial probes against the oracle, not the summaries) found seven
issues; all are fixed with regression tests (`test/canary/review-regressions.test.ts`), and the
vendored ts-evaluator corpus — planned in S0 but never run — is now part of `npm test`.

### Fixes
1. **Sandbox escape (HIGH).** `[].constructor.constructor("return fetch")()` reached the *real*
   `Function` and real `fetch` inside the "sanitized" canary. Fix: a **host guard at the interpreter
   boundary** (`VMOptions.hostGuard`): every property/element read, host call/construct result,
   import binding, destructured host prop, iterator value and resume value passes `sanitize()`; every
   host callable passes `beforeCall()` (which also vets `Function.prototype.call/apply/bind` aimed at a
   forbidden target). The canary maps the real `Function`/`AsyncFunction`/`GeneratorFunction`/
   `AsyncGeneratorFunction`/`eval` to the eval shim wherever they surface, wraps `Reflect.apply/
   construct`, and treats string timer callbacks as `eval`. Principle: only the interpreter sees
   every read and every call, so that is where a sandbox must be closed — not by global name.
2. **Async reaches were invisible (HIGH).** A reach after an `await`, in a `.then`, or in a timer
   happened after the synchronous `runCanary` returned `ok:true`, then surfaced as an
   unhandledRejection. Fix: `runCanaryAsync` awaits completion and **drains tracked work** — async
   fibers (`VMOptions.onAsyncFiber`), timers/microtasks (wrapped), and promise reactions (`then/catch/
   finally` wrapped via the guard, counted until the source settles); a divergence inside any of them
   is recorded, never uncaught. The sync `runCanary` now **fails loud** (`ok:false`, `pendingAsync`)
   when guest async work is outstanding. An uncatchable error rejecting an awaited promise is no
   longer injected as a guest `throw` (it was swallowable).
3. `fork()` rebound cloned closures to the *source* VM (the comment claimed otherwise). Fixed.
4. `yield`/`await` inside a synchronous sub-evaluation (computed key, default value) silently resumed
   with `undefined`; now a `TsvalInternalError`.
5. `this` semantics were never tested and the oracle ran sloppy. Decision recorded: **module/strict
   semantics** (top-level and plain-call `this` are `undefined`); the oracle now evals strict with an
   undefined receiver; `this` cases added.
6. `var` hoisting was shallow (a plain read before a block-buried `var` threw). Now a recursive
   collector (blocks/loops/try/switch, destructured names; not into nested functions/classes).
7. Fork policy: guest class prototypes are shared consistently (a mid-construction fork kept a cloned
   `ClassMeta.proto ≠ ctor.prototype`); accessor closures are rebound; `callSite` is also set for
   host `new` (WebSocket annotation).

Also from the corpus: TS `this:` pseudo-parameters were bound as positional params (shifted every
arg of `fn.call(obj, …)`), `Function.length` ignored defaults/rest, `new.target` was unimplemented
(now threaded through host-mediated construction), and an anonymous class expression reported
`.name === "Ctor"` (V8 name inference from the host variable).

### The ts-evaluator corpus (`test/differential/ts-evaluator*.ts`)
- `loadCorpus()` extracts the program from every `executeProgram(<literal>, …)` in the 42 vendored
  test files: **148 programs** (the other 11 calls pass file arrays). Node is the oracle; ts-evaluator's
  own expectations are not used (ASSIGNMENT §5 S0 framing).
- `classifyDifferential` compares **structurally** (`structural()`): functions/classes → `{name,
  length, static props}`, instances → constructor name + own data, Map/Set/Date/Error by content —
  because values from two engines can't be reference-equal. It tallies **value-match** separately
  from **both-threw** (agreement on failure is weaker evidence).
- Result: **118 value-match, 23 both-threw** (each with the same error class+message on both sides,
  or an `import`/`require` program neither side can run in this harness), **7 known gaps** listed in
  `ts-evaluator-gaps.ts` with reasons and run as `todo` — all seven are **decorators** (runtime-emit,
  unimplemented; they'd become visible the moment they pass).
- Oracle hardening: the Node side runs real code, so `process`/`require` are shadowed with inert stubs
  on *both* sides (a corpus program's `process.exit` was silently killing the runner), and tsc targets
  ES2022 so standard decorators are downleveled for Node.
- Runner quirk: `node --test`'s per-file subprocess mode stops after an eval'd `setTimeout`; the npm
  scripts use `--test-isolation=none` (in-process). `npm run test:corpus` runs just the corpus.

### Then: decorators + fork-based path exploration ✅
- **Legacy decorators** (`applyLegacyDecorators`): exactly tsc's `__decorate`/`__param` semantics —
  per-member decorators right-to-left with descriptor chaining; parameter decorators first (last
  param first); class decorators last, may replace the constructor. The oracle transpiles with
  `experimentalDecorators` (the corpus uses parameter decorators, which only exist there). Closed all
  7 corpus todos → **the ts-evaluator corpus is fully green: 125 value-match, 23 both-threw, 0 todo.**
  Standard (TC39) decorators have different semantics and are not modeled.
- **`exploreCanary`** — the canary's answer to one-run-one-path (ASSIGNMENT §3): run stepwise and, at
  every `if`/`?:` whose condition was just evaluated (frame phase 1, value on the operand stack),
  `fork()` and steer the fork down the other branch by negating that value. Paths run BFS under the
  same shims; each reach is stamped with its `path`; the recorder keeps a first divergence per path.
  Bounded by `maxPaths` (reports `truncated`) and a per-path step budget. A fork skips the one branch
  point it was born at (otherwise it re-forks forever). Verified: a `fetch` behind `if (mode ===
  "danger")` that a plain run never reaches is found on the forced path; both arms of a `?:` yield
  their resource (Axis-2 across paths); nested branches fork recursively with full decision trails;
  a forced path that throws is contained. Synchronous paths only; loop conditions are not forced.

### Supported-surface policy (decided 2026-09-04): strict ECMAScript + erasable TypeScript
User direction: cut loose anything not generally accepted as standard, and sloppy-mode-only behavior.
Applied as: **strict-mode ECMAScript + erasable TypeScript**, `enum` retained (verified; drop on
request). Out-of-scope constructs are **refused loudly** (`TsvalInternalError`), never silently
mis-run — the failure mode a canary must never have. See README "Supported surface".
- Removed the legacy-decorator implementation added earlier in the day: legacy and standard decorators
  share syntax with different semantics, so running one as the other is a correctness hazard; both
  are now refused (`assertSupportedClassSurface`). Parameter properties (`constructor(public x)`) were
  being *silently ignored* — now refused. `namespace`/`import =` stay unimplemented (loud).
- Strict semantics enforced where tsval was still sloppy: assignment to an undeclared name is a
  `ReferenceError` (was: implicit global in the sandbox); a function declaration in a block is
  block-scoped (was: lifted to the function scope, web-compat behavior); `undefined`/`NaN`/`Infinity`
  are read-only. Differential cases added for each; the oracle already ran strict.
- Corpus: a separate **OUT_OF_SCOPE** category (skipped with reason, and each such program is
  asserted to fail *loudly* in tsval) distinct from KNOWN_GAPS (todo): 7 legacy-decorator programs
  + 1 parameter-property program.

### Then: the remaining in-surface async/ES2022 gaps ✅
One addition to the fiber machinery made all four fall out: a suspension point now says *which kind*
it is (`vm.pauseKind: "yield" | "await"`), because an async generator does both.
- **Async generators** (`async function*`, `VM.createAsyncGenerator`): `next/return/throw` return
  Promises; the driver keeps stepping through `await` pauses and settles a request on a `yield` pause
  (the yielded value is itself awaited, per spec); requests are serialized through a promise chain
  (the spec's request queue). `yield*` inside one delegates to an async iterable (or adapts a sync
  one), awaiting each result. Sync generators / async functions now fail loud on the wrong pause kind.
- **`for await (x of …)`** (`forAwaitOf`): an async iterator's results are awaited; a sync iterable's
  *values* are awaited (async-from-sync). Each await suspends the enclosing fiber, so the loop is
  steppable/forkable like any other; `break`/`continue` via the usual loop-frame unwinding.
- **Top-level await** (`VM.runAsync`, `interpretAsync`): the main context suspends like a fiber and
  resumes when the awaited value settles (a rejection is injected as a throw at the await). The sync
  `run()` — and the stepping helpers via `runUntil` — stop at a top-level pause and `run()` refuses it
  loudly instead of silently resuming with `undefined`. `runCanaryAsync` drives it; exploration stays
  synchronous-paths-only (loud).
- **`static { … }` blocks**: run at definition time in source order with static fields, `this` = the
  class. Fixing their tests exposed a real gap: a class body had no **inner binding of its own name**,
  so `static { A.x = … }`, `static y = A.x * 2`, and a *named class expression* referencing itself
  all failed. `createGuestClass` now gives the body an inner scope binding the name (JS's immutable
  inner class binding); the outer binding is unchanged.
- Verified differentially (Node oracle): 10 async-generator/for-await programs, 3 static-block
  programs, 2 inner-name programs; top-level await unit-tested (Node's script `eval` has no TLA).
  **403/403.**

### Still open
- Sensitive-type matching is by type name; the checker's `isTypeAssignableTo` is the refinement.
- Exploration drains no async work per path and forces only `if`/`?:`; a smarter explorer would
  dedupe paths by (branch point, decision) and prioritize paths that reach new capabilities.
- `for await` `break` does not call the iterator's `return()` (only observable via a `finally` in the
  generator); labeled `continue` targeting a `for await` works via the standard loop unwinding.

---

## S6 — Type-aware ✅ (2026-09-04)

**Status: green.** `npm test` → 203/203. Typecheck clean. The final staged item — S0→S6 all done.

### TypeChecker front-end (`src/program.ts`)
- `createTypedProgram(code)` builds an in-memory `Program` + `TypeChecker` over one virtual file,
  delegating lib.d.ts reads to the host FS (a browser build supplies libs via a virtual FS — same
  seam). `lib.es2022 + lib.dom` so `fetch`/`URL`/`WebSocket` type as capability sinks. Returns the
  Program's own `sourceFile` so node identities line up with checker queries. `typeOfNode(checker,
  node)` → the static type string. Parse-only stays the default; you pay for this only when asked.
- `createTypedVM(code)` (interpret.ts) seats the VM on the typed SourceFile with the checker attached.
- The parser stays a swappable seam (open decision #3): `createVM` uses `ts.createSourceFile`;
  `createTypedVM` uses the Program.

### VM type access (`src/vm.ts`)
- `VMOptions.typeChecker` → `VM.typeChecker`. `VM.callSite` exposes the CallExpression currently
  invoking a host function (set only around the host `apply`), so a shim can introspect the static
  type of its argument via the checker — the hook the type-directed canary uses.

### enum runtime-emit (`handlers.ts`, ASSIGNMENT §4)
- Numeric auto-increment + reverse mapping (`E[0] === "A"`); string members; flag enums (`A | B`);
  members referencing earlier members (bare or `E.x`) via a layered member scope. Verified against
  Node's tsc-emitted enum objects through the differential oracle.
- Also added no-ops for erased declarations (`type`, `interface`, `export {}`, `import =`) and skip
  **ambient (`declare`)** statements in hoist + execution (they describe host shapes for the checker).

### Type-directed canary (`src/canary.ts`)
- `runCanary(code, { useTypes })` annotates each reach with `valueType` — the **static type of the
  resource argument** at the callsite (e.g. `fetch(u)` where `u: URL` → `"URL"`).
- `sensitiveTypes: [...]` flags reaches whose resource argument's type matches a sensitive type — "a
  value assignable to X flowed into a sink" (ASSIGNMENT S6). Verified: a `Secret`-typed URL into
  `fetch` is flagged; a `"..." + (secret as string)` concatenation launders the brand to `string` and
  is **not** flagged (no false positive). Type-aware runs still catch capability divergence.
- Assignability is a type-name match on `typeToString` for now (documented heuristic); the checker's
  proper `isTypeAssignableTo` is a refinement, as is the TS 7.1 native backend.

---

## S5 — Capability shims + canary ✅ (2026-09-04)

**Status: green.** `npm test` → 189/189. Typecheck clean. This is the *purpose* the interpreter serves
(ASSIGNMENT §1, §5): run code with instrumented capability shims and hard-abort on any runtime
divergence from the static prediction.

### Static kernel, verified from source
`lib/util/silo/callsites.ts` was renamed to **`reach.ts`** (the brief was stale). Read both:
- `detect.ts` → `detect(code): string[]` — coarse capability set. Vocabulary: **net, fs:read,
  fs:write, fs (coarse), exec, env, eval**.
- `reach.ts` → `findReach(code): Reach[]` = `{capability, value, callee, safe, line, column}` — the
  resource axis (the literal URL/path/command/env-key). Matcher config is data (`CALL_DETECTORS`).

The canary is the *dynamic complement*: the **predicted set is silo's static output**, passed in as
`predicted`. tsval does not re-implement the static analysis (and stays free of oxc / the `lib` dep).

### Module system (prerequisite — shims arrive via `import`/`require`), `handlers.ts`/`vm.ts`
- `VMOptions.resolveModule(specifier) → namespace` is the injection seam. `import` (default/named/
  namespace/side-effect, ESM-hoisted in `hoist`), `require(spec)` (a host global), and dynamic
  `import(spec)` (→ `Promise` of the namespace) all resolve through it. `import type` elided.

### The canary (`src/canary.ts`)
- **Sanitized environment** (`realGlobals: false`): `safeGlobals()` exposes only pure intrinsics +
  formatting/timing/console — no capability surfaces. `globalThis`/`self` self-reference the shimmed
  globals so **reflection-based access is caught, not silently denied**.
- **Recording shims** for every capability, keyed to silo's vocabulary and name lists: `fetch`/
  `WebSocket`/`http|https|net`.get/request → net; `fs`/`fs/promises` read+write fns → fs:read/fs:write;
  `child_process` spawn/exec/… → exec; `process.env` (a Proxy) → env; `eval`/`Function` → eval. Each
  records `{capability, value, callee, safe}` (silo `Reach` shape) — the **Axis-2 resolver** captures
  the *concrete* resource at runtime, including dynamically-built values static analysis can't resolve.
- **Divergence tripwire:** on a recorded reach whose capability `!covers(predicted, …)` (coarse `fs`
  covers `fs:*`), throw `CanaryDivergenceError` — **uncatchable** (branded `UNCATCHABLE`; the step loop
  rethrows it to the host so guest `try/catch` can't swallow the tripwire). `runCanary` catches it at
  the boundary → `{ok:false, aborted:true, divergence}`.
- Verified (`test/canary/canary.test.ts`): declared caps pass; undeclared net/fs:write/exec/env
  hard-abort; **sneaky constructions caught** — aliasing (`const f = fetch`), string-concat
  (`globalThis["fe"+"tch"]`), `self.fetch`, `Reflect.get(globalThis,"fetch")`; guest `try/catch`
  cannot swallow the abort; coarse `fs` covers granular; Axis-2 resolves `https://internal-service.
  corp/api` from `"https://" + host + ".corp/api"`; multiple reaches recorded in order.

### Open / follow-ups
- **Fork-based multi-path exploration**: `VM.fork()` (S4) is available but not yet wired into
  `runCanary` (would explore both branches of a data-dependent conditional to beat one-run-one-path).
- Wiring to silo `guard`/`review`/`runs` for full integration; passthrough mode performs real calls.
- Whole-`process.env` (no key) / destructured env; `eval` argument execution (shim records, doesn't run).
- **Next: S6** — type-aware (add `TypeChecker`; type-directed canary: "a value assignable to
  `RequestInfo` flowed into a sink").

---

## S4 — Snapshot / fork ✅ (2026-09-04)

**Status: green.** `npm test` → 179/179. Typecheck clean. `VM.fork()` returns an independent copy of
the machine at its current point — the capability that lets the canary (S5) explore more than one path
from a single run.

### `VM.fork()` (`src/vm.ts`)
- Deep-copies the whole mutable state — value stack, control stack (frames), scope graph, `signal`,
  `completion`, pause/fiber scalars — through one recursive `clone` with a shared `seen` map (so
  reference identity and cycles are preserved *within* the fork), then assigns it onto a fresh VM.
- **The guest/host split (ASSIGNMENT §3):** clone program-created state, share host state.
  - **Cloned:** plain objects, arrays, `Scope`s (bindings copied; parent chain rebuilt), guest
    closures (rebound to the forked VM, closure remapped to the cloned scope), guest class *instances*
    (own data copied, prototype shared), and value-like builtins `Date`/`RegExp`/`Map`/`Set`.
  - **Shared:** host functions & injected shims, the root `globalObject`, AST nodes, guest **class
    constructors** and prototypes (behavior, not data), `Promise`/`Error`/other host instances, and
    live generator/async fibers (branded `FIBER_BRAND`).
- Verified (differential-style in `test/vm/fork.test.ts`): guest object/array mutation stays local;
  shim identity preserved; a **mid-`while`-loop fork** resumes independently (control stack cloned) —
  original → 45, tampered fork → 20; closures keep their own captured variable; `instanceof` + methods
  survive a fork with independent instance data; step budget diverges.

### Known fork limitations
- Forking across a **live generator/async suspension** shares the fiber (branded non-cloneable) — the
  two forks would drive the same suspended machine. Cloning a suspended fiber (its own frames/values)
  is possible later but not needed for statement-boundary forks.
- Host-returned collections that carry host identity are cloned as plain data (fine for arrays/objects;
  a genuine host resource wrapped in a plain object is the edge).

### Also closed here
Object-literal **method & accessor shorthand** (`{ m() {} }`, `{ get x() {} }`) — previously an S2
gap — now implemented (with computed keys).

### Next: S5
Capability shims + canary: inject recording/deny shims (reuse `lib/util/silo/callsites.ts` matcher
config for what to shim), run with `realGlobals:false`, and trip on `runtime-caps ⊄ static-caps`.
Fork enables exploring multiple paths per run.

---

## S3 — Stepping API + async/generators ✅ (2026-09-04)

**Status: green.** `npm test` → 170/170 (165 differential incl. 12 generator + 11 awaited-async, +
5 VM/stepping, + 5 new stepping/fiber tests). Typecheck clean. This is the payoff for the explicit-
stack design: suspension falls out of saving/restoring the machine's own stacks.

### Fibers (the suspension substrate, `src/vm.ts`)
- A **fiber** = a snapshot of the machine's mutable state `{ frames, values, signal }` plus `done`/
  `started`. `stepFiber(fiber, input)` swaps a fiber in, runs `while (!finished && !paused)`, and swaps
  back — resuming feeds `sentValue` (a `.next(v)` / resolved await) or injects a `return`/`throw`
  signal at the suspension point. `ExecContext` save/restore now backs `callGuestFromHost`,
  `evalNodeSync`, `constructGuestSync` (all via `runSub`) **and** fibers, so nesting is safe.
- **`yield` / `await`** (`handlers.ts`) suspend by setting `vm.paused` + `vm.pauseValue` and parking
  the frame at phase 2; on resume phase 2 yields `vm.sentValue`. Same mechanism for both; the driver
  interprets the payload (generator: the yielded value; async: the awaited operand).

### Generators
- `function*` calls return a lazy generator object (`VM.createGenerator`) with `next/return/throw/
  [Symbol.iterator]`. Verified: `[...g()]`, `for-of`, spread, bidirectional `yield` (sending values
  in), `yield*` (delegation + return value), infinite generators (`while (true) yield`), `return`
  mid-body, destructuring inside generators, `.throw()`/`.return()` injection.

### async / await
- `async` calls return a real host **Promise** (`VM.callAsync`), driven by `await` suspensions:
  each `await` parks the fiber and attaches `.then` to the operand, resuming with the resolved value or
  injecting a `throw` on rejection. Verified: sequential awaits, `await` in loops, `Promise.all`,
  nested async, `try/catch` around `await`, real `setTimeout`, rejection → Promise rejection.
- Async/generator functions cross the host stack at the fiber boundary (the driver is host-scheduled);
  the body itself runs on the explicit stack and is fully suspendable.

### Stepping API polish
- `addBreakpoint(pos)` / `addBreakpointsByLine(...)` + `runToBreakpoint()` (statement-level — a
  statement and a same-position child expression are disambiguated). `currentNode`, `location(node?)`
  (0-based line/char via the stored `sourceFile`), `atStatementBoundary()`, `atBreakpoint()`.

### Open after S3
- `for await...of`, async generators (`async function*`), top-level await → still `throw`/unsupported.
- Object-literal method/accessor shorthand; `static {}` blocks; exotic host-`extends`; recursive `var`
  hoisting (all carried from S2).
- **Next: S4** — snapshot/fork (`clone()` of frames+values+scope graph, sharing host objects/shims by
  side-table). Fibers are already plain-data contexts, which sets this up.

---

## S2 (part 2) — Classes ✅ (2026-09-04)

**Status: green.** `npm test` → 132/132 (127 differential + 5 VM/stepping). Typecheck clean.

### Added (`src/handlers.ts` "Classes" section)
- **ClassDeclaration / ClassExpression** → a real host constructor function branded `__tsvalClass`,
  with methods on `prototype`/the constructor as guest functions (so method calls run on the explicit
  stack). Instance & static **fields**, **methods**, **get/set accessors**, **private (`#`) fields**,
  computed member names.
- **Inheritance**: `extends` (guest or host superclass), prototype + static chain wired via
  `Object.create`/`setPrototypeOf`. **`super(...)`** in derived constructors and **`super.method()` /
  `super.x`** via a per-method `[[HomeObject]]` bound on the method's function scope.
- **Construction on the explicit stack** via a synthetic `construct` frame (steppable; `super()` chains
  by pushing a parent `construct` frame + an `initfields` frame in spec order — parent ctor, then this
  class's field initializers). `VM.constructGuestSync` handles host-initiated `new`.
- Member **compound assignment** (`obj.p += x`, `o[k] *= y`) and member **`++`/`--`** (`this.n++`).
- Field/static initializers and computed keys evaluate via `VM.evalNodeSync`.

### Known class gaps
- `extends` a **host** built-in (Error/Array/Map): best-effort (`Object.assign` of a freshly
  Reflect-constructed parent) — fine for plain cases, not exotic ones. `new B() instanceof A` and
  `extends Array` (basic) do pass.
- `static { ... }` initialization blocks; object-literal method/accessor shorthand → still `throw`.
- Construction crosses the host stack only when reached *from* host code (`constructGuestSync`); guest
  `new` is fully on the explicit stack.

---

## S2 (part 1) — Control flow, destructuring, spread ✅ (2026-09-04)

**Status: green.** `npm test` → 110/110 (105 differential + 5 VM/stepping). `npm run typecheck` clean.
The unwinding machinery the VM was designed around (ASSIGNMENT §3) is now fully exercised.

### Added
- **Loops**: `for`, `for-of`, `for-in`, `while`, `do-while`. Loop frames set `frame.isLoop` +
  `continuePhase`; `unwind()` catches matching `break`/`continue`. `for` does per-iteration `let`/
  `const` binding (`copyPerIteration`, spec `CreatePerIterationEnvironment` — closures in a loop
  capture their own binding). for-of/for-in bind a fresh scope per iteration; host iterables only.
- **break/continue**, including **labeled** (`LabeledStatement` sets the label on the child loop/switch
  frame; a labeled block is caught by the label frame itself).
- **switch**: lazy `case` test evaluation (side effects preserved), fall-through, `default`, one shared
  block scope; `break` caught by the switch frame.
- **try/catch/finally**: `unwindTry` routes `throw`→`catch`, runs `finally` on any escaping signal and
  re-raises it; `catch` binding (identifier), optional binding (`catch {}`).
- **Host-error → guest-throw**: `step()` wraps handler dispatch; a host runtime error (e.g.
  `JSON.parse` throwing) becomes a catchable guest `throw`. Interpreter-internal errors
  (`TsvalInternalError` from `unimplemented()` / invariants, in `src/errors.ts`) stay loud.
- **Destructuring** (`bindTarget`): array + object patterns, nested, holes, rest, defaults, computed
  keys, renamed props — for `var`/`let`/`const`, parameters, and for-of/in targets. Leaf
  sub-expressions (defaults, computed keys) use `VM.evalNodeSync` (a synchronous single-expression
  sub-run; host-stack at the entry only).
- **Default & rest parameters**; **spread** in array literals, object literals (`{...o}`), and call/new
  arguments; **element-access callee** (`fns[0]()`, `o["m"]()`).
- `VariableStatement` now routes through a `VariableDeclarationList` handler (shared with `for`-init).

### Bug fixed (found via nested-literal differential intent)
Array/Object/Template combine phases used `frame.valuesBase` (captured at *push* time) to splice
operands. When a parent pushes sibling frames at once they share that base, so a later sibling spliced
earlier siblings' results too — flattening nested arrays (`[[1,2],[3,4]]` → `[[1,2],3,4]`). Fixed by
capturing `frame.base` at the *start* of phase 0 (after earlier siblings are already on the stack).

### Still open after S2
- Object-literal method/accessor shorthand (`{ m() {} }`, `{ get x() {} }`) → still `throw`.
- `static { ... }` blocks; `extends` a host built-in is best-effort (see class gaps above).
- Recursive `var` hoisting into nested blocks/loops (hoist is still shallow) — matters once code relies
  on a `var` inside a block being visible/`undefined` earlier in the function.
- **Next: S3** — stepping API polish (breakpoints by node `pos`) + async/await & generators as machine
  suspension. Then S4 (snapshot/fork), S5 (shims + canary), S6 (types).

_Assignment destructuring (`[a,b] = x`, `({x} = o)`, nested/rest/defaults/member targets) landed with
the class work (`assignPattern` in handlers.ts); 142/142 green._

---

## S0 + S1 — Scaffold, differential oracle, skeleton stepped VM ✅ (2026-09-04)

**Status: complete and green.** `npm test` → 60/60 pass (55 differential + 5 VM/stepping). `npm run
typecheck` clean. Acceptance (KICKOFF/ASSIGNMENT S1) met: `const u = "https://x"; const n = 1 + 2;
id(u, n)` runs end-to-end, single-steps via `stepStatement()`/`step()` with observable value/control
stacks, and the injected `id` shim receives `("https://x", 3)`. Deep guest recursion (`down(20000)`)
runs with **no host-stack overflow**.

### Toolchain decisions
- **No build step.** Node 24 runs `.ts` natively (type-stripping). Tests use built-in `node:test` +
  `node:assert`. Only runtime dep is `typescript` (5.9.3) for `ts.createSourceFile`; `@types/node` is
  a devDep for `tsc --noEmit`.
- `package.json` `type: module`; import specifiers use explicit `.ts` extensions (Node ESM + native TS).
- Test discovery scoped to `test/**/*.test.ts` so the vendored ts-evaluator suite isn't picked up.

### Architecture (as built)
- **Value model:** native JS values (mirrors ts-evaluator's `Literal`). No boxing.
- **VM** (`src/vm.ts`): `values[]` operand stack + `frames[]` control stack + `step()`. A `Frame` is
  plain data `{ node, phase, scope, valuesBase, kind?, ...scratch }` — no closures, so state stays
  cloneable for snapshot/fork (S4). Dispatch: synthetic frames by `frame.kind`, else by `node.kind`.
  Unknown kinds `throw "unimplemented: <kind>"` (grow-against-oracle loop, ASSIGNMENT §4).
- **Handlers** (`src/handlers.ts`): one handler per SyntaxKind, phase-sequenced. `phase 0` pushes child
  frames (reverse eval order); later phases combine children's operands. Semantics cross-checked
  against ts-evaluator's `src/interpreter/evaluator/evaluate-*.ts` (the semantics spec).
- **Control flow = unwinding** via `vm.signal` + `unwind()`. `return` implemented (caught by the
  synthetic `call` frame). Uncaught `throw` rethrows to the host. `valuesBase` truncation keeps the
  operand stack balanced when unwinding through mid-evaluation frames.
- **Scope** (`src/scope.ts`): own implementation (sval's `Scope` is **not** in this tree; writing a
  clean one is smaller and fits the stack VM). Function/block scoping, `var` hoist to function scope,
  `let`/`const` TDZ, `const`-reassign throws, `this` binding, `realGlobals` fallback to the host
  `globalThis` (default on) for max differential parity — the canary stage (S5) turns it off.
- **Guest functions** (`src/values.ts`): a real JS function branded with `__tsval` (node + closure).
  Guest→guest calls run on the **explicit stack** (synthetic `call` frame). Host→guest (array
  callbacks, shims) go through `VM.callGuestFromHost`, a nested loop — that crossing uses the host
  stack (documented tradeoff; guest→guest never does).
- **Completion value** = value of the last `ExpressionStatement` (`eval` semantics). This is the
  oracle's compared output.

### Differential harness (`test/differential/`)
- Oracle = tsc `transpileModule` (type-strip) → direct `eval` in Node, capturing completion value +
  `console.*` + whether it threw. `assertDifferential(code)` compares tsval vs Node on all three.
- `cases.ts`: 55-case starter corpus. Bigger corpora (ts-evaluator tests, TS `tests/cases/`, test262)
  plug into the same `assertDifferential` later.

### SyntaxKind coverage implemented
Literals (numeric/bigint/string/template-noSub/regex/true/false/null), Identifier, `this`,
Parenthesized + type-only wrappers (`as`/`<T>`/`!`/`satisfies`), TemplateExpression, Array/Object
literals (PropertyAssignment + Shorthand), Property/Element access (+ `?.` guard on reads/calls),
Prefix/Postfix unary (incl. `++`/`--` on identifiers), `typeof`, `void`, Binary (all arithmetic/
bitwise/comparison/`in`/`instanceof`/comma, `=`, compound-assign, `&&`/`||`/`??` short-circuit),
Conditional `?:`, Function/Arrow/FunctionExpression, Call (incl. method calls + rest params), `new`
(host constructors), SourceFile/Block/If/Return/Throw/Expression/Empty/Variable statements.

### Known gaps → next (S2 coverage)
- **Loops**: for / while / do-while / for-in / for-of; **break/continue** (loop-frame catch in
  `unwind`); labeled statements.
- **try/catch/finally**: `try`-frame catch in `unwind` + finalizer-on-unwind.
- **switch**.
- **Classes/super**, `new` for guest classes.
- **Destructuring**: params, `var`/`let`/`const` binding patterns, assignment targets.
- **Spread**: array literal, call args, object spread.
- **Default parameter values** (currently `throw`s unimplemented).
- **Computed property names**; ElementAccess as a method-call callee.
- **Recursive `var` hoisting** into nested blocks/loops (S1 hoist is shallow — see `hoist()` note).
- Then S3 stepping API polish + async/generators (machine suspension), S4 snapshot/fork (`clone()`
  with host-object sharing), S5 capability shims + canary, S6 TypeChecker.

### Files
```
src/frontend.ts   parse() + syntaxKindName (dup-enum-safe)
src/scope.ts      Scope: var/let/const, TDZ, this, global fallback
src/values.ts     GuestFunction brand + isGuestFunction
src/vm.ts         VM: stacks, step/run/stepStatement/runUntil, unwind, callGuestFromHost
src/handlers.ts   per-SyntaxKind handlers + synthetic `call` + operator semantics + hoist
src/interpret.ts  createVM / interpret convenience
src/index.ts      public exports
test/vm/step.test.ts              acceptance: stepping, shim, deep recursion
test/differential/{harness,cases,differential.test}.ts   S0 oracle
vendor/ts-evaluator/              reference + oracle source (MIT, LICENSE.md present)
```
