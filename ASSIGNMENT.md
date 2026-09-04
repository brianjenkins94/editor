# tsval — a stepped, stack-based, TypeScript-AST interpreter

> Assignment brief for a session picking this up cold. Self-contained on purpose.
> Companion: [`SVAL-NOTES.md`](./SVAL-NOTES.md) — sval internals (now **reference material**, see §2).

## 1. What we're building and why

**Committed design (decided 2026-09-04):** a **stack-based interpreter** over the **native TypeScript
`SyntaxKind` AST** (Path B), with **stepped execution**. This is the maximal-capability combination,
chosen deliberately.

Driving purpose (larger project in `../lib`): a **capability analysis system**. A static kernel
(`lib/util/silo/reach.ts` + `detect.ts`, oxc-based) predicts which capabilities a file reaches and
against what resources (URLs, paths, commands). tsval is the **dynamic complement**:

- **Canary / divergence tripwire** (primary role): run the code with instrumented capability shims; if
  runtime exercises a capability/callsite the static pass didn't account for — a "sneaky construction"
  (`globalThis["fe"+"tch"]`, aliasing, reflection, dynamic dispatch) — that's a divergence →
  **hard abort + route to review**. Turns "did we model every construction?" (impossible) into
  "did runtime step outside what we modeled?" (checkable).
- **Axis-2 resolver** (free from the same run): resolve dynamic URLs/paths static analysis can't
  (const/template/runtime values), by observing what the shims receive.

Must run in the **browser** (the static kernel already does). Pure JS + `typescript` (later TS 7.1
WASM) → fine.

## 1b. ts-evaluator changes the build-vs-adopt calculus (READ THIS)

**[ts-evaluator](https://github.com/wessberg/ts-evaluator)** (wessberg, MIT, v2.0.0) is a mature
interpreter that is *much* closer to tsval than sval ever was. Verified from source:

- **It already has:** Path B (one evaluator file per `SyntaxKind`, ~complete — 216 files); optional
  `TypeChecker` (type-aware, degrades gracefully); a **modular capability policy** (`policy/`:
  network, io read/write, process exit+child_process, console, nondeterministic, module) **plus
  `maxOps`/`maxOpDuration`** execution bounds; environment presets (node/browser/ecma) +
  `create-sanitized-environment` + **`moduleOverrides`** (shim built-ins); browser support; MIT.
- **It lacks exactly our two distinctive asks:** it's a **recursive, one-shot tree-walker** (no
  generators, host-stack recursion; control flow via lexical-env flags + a current-error slot; values
  on a simple operand `Stack`). So **no stepping, no snapshot/fork.**

**Consequences:**

1. **ts-evaluator, not sval/DumbLang, is the base/reference.** It's the right AST (Path B), with
   coverage that dwarfs DumbLang and a policy model more mature than we'd build. sval's only remaining
   lesson is its generator-async trampoline; DumbLang is historical.
2. **The deliverable is tsval — the stepped, stack-based interpreter (§1, §2, §3).** Its reason to
   exist is precisely what ts-evaluator can't do: **stepping + snapshot/fork** (single-step debugging;
   path-exploration to beat the canary's one-run-one-path limit; interactive per-call approval mid-run).
   Build the interpreter. Use ts-evaluator's `evaluate-*.ts` as the per-`SyntaxKind` semantics spec
   (each becomes a continuation-frame handler in your VM), its tests as an oracle, and its
   policy/environment/moduleOverride *design* when you reach the shim stage.
3. **The canary is a LATER stage (S5), not the first build target.** It is the *purpose* the
   interpreter serves — the interpreter's shims + stepping + fork are what make a good canary — not a
   substitute for building the interpreter. (Aside: ts-evaluator's policy traps could run a crude
   one-shot canary today — feed the static-predicted set as the policy, deny the rest. Treat that only
   as an optional throwaway spike to sanity-check the static→dynamic loop; it is NOT the deliverable and
   must not replace building tsval.)

Everything below (§2–§8) describes the VM you are building; §1b just says what to lean on while building
it.

## 2. IMPORTANT — the VM is greenfield-executor over ts-evaluator's substrate

Path B + stack-based means we **discard both of sval's reusable assets**:

- sval's handlers are **ESTree-shaped** (`node.type`); Path B walks **tsc `SyntaxKind`** (`node.kind`)
  → every handler is rewritten (this is what DumbLang, §6, did).
- sval's executor is **`yield*` generator recursion**; we use an **explicit-stack VM loop** → the
  handler *structure* is discarded too.

**So tsval is a greenfield stack VM over a typed AST**, with sval and DumbLang as *semantics
references* and sval's *test corpus as a regression oracle*. Budget it as its own project — the
largest piece in this line of work. What actually carries over:

- **Reuse (code):** sval's `Scope` (`scope/index.ts` — language-agnostic: function/block scoping, TDZ,
  `with`, window fallback) + `Var`/`Prop`; the **injection/sandbox concept** (`import()` + sandbox).
- **Reuse (oracle):** a **differential** harness (tsval vs Node) fed by ts-evaluator's tests (executor
  regression), TypeScript `tests/cases/` (as input programs), test262, and sval's tests — see S0.
- **Reference only:** sval's `evaluate/` handlers (read to learn *what each construct must do*, then
  re-express in the VM — see `SVAL-NOTES.md`); DumbLang's SyntaxKind dispatch; tsc's own emitter/binder
  for constructs with runtime emit.

## 3. The machine (CEK/CESK-style explicit-continuation-stack walker)

Not a bytecode compiler — keep the AST as the unit so source-mapping/stepping stay trivial. State:

- **`values`** — operand stack (sub-expression results).
- **`frames`** — control stack; each frame ≈ `{ node, phase, scope }` (the reified recursion; `phase`
  = which child to evaluate next / what to do once children resolve). Specialized frame kinds for
  calls, loops, try/finally, catch.
- **`env`** — the current `Scope` (sval's), referenced by frames; pushed/popped on block enter/exit
  (this structurally fixes DumbLang's scope-restoration bug).

`step()` pops/peeks the top frame and does one unit of work: on first visit, push child frames (reverse
eval order) + advance phase; once children's values are present, compute the node's result, pop, push
the value.

Everything we want falls out of this one loop:

- **Stepping:** don't run to completion. `step()` (one frame) / `stepStatement()` (run to the next
  statement-node frame) / `runUntil(pred)` / breakpoints by node `pos`. The loop *is* the driver — no
  sentinels/generators.
- **Control flow = unwinding:** return/break/continue/throw pop frames until the matching
  function/loop/try frame. `try/finally` = run finalizer frames during unwind; labeled break = unwind
  to the labeled frame. (These are sval's hard cases; explicit unwinding is cleaner than bubbling.)
- **Calls:** push a call frame that installs a new function `Scope`, binds params, pushes the body's
  frames; return pops back to it. Deep guest recursion = heap growth, **no host-stack overflow**.
- **Snapshot / fork:** `clone()` the state (values + frames + env graph are plain data). **Subtlety:
  share, don't clone, injected host shims/intrinsics** — clone only guest state (mark host objects or
  keep shims in a side-table by id). Fork beats the canary's one-run-one-path limit.
- **async/await + generators:** machine *suspension* (save state, resume on settle / on `.next()`).
  Easier stack-based than sval's trampoline; good for fido's async flows.
- **Step budget** is free (one loop turn = one step).

## 4. Path B specifics (tsc / TS 7.1 SyntaxKind)

- **Parsing vs typing:** `ts.createSourceFile(...)` gives `SyntaxKind` nodes but **no types**.
  Type-*awareness* needs a `Program` + `TypeChecker` (createProgram over a virtual FS in-browser) —
  MBs and slow via the JS `typescript` package today; fast later via **TS 7.1 native (Go→WASM, beta
  ~Sept 2026, microsoft/TypeScript#63703)**. **Run parse-only (types erased) first; add the checker as
  its own stage.**
- **Dup-enum gotcha:** `SyntaxKind` has duplicate numeric values across token ranges — use DumbLang's
  `enumerateReverseLookup` to get name↔number both ways.
- **Runtime-emit constructs** (must be *implemented*, not erased): `enum`, `namespace`/module,
  parameter properties, decorators, `import =`. Reference tsc's emitter for exact semantics.
- **Large node surface:** implement incrementally with a `throw "unimplemented: <kind>"` default (like
  DumbLang) and grow against the test oracle.

## 5. Staged plan

- **S0 — Scaffold + differential oracle harness.** New repo. Build the harness around **differential
  testing**: `tsval-output === Node-output-on-(tsc-emitted or type-stripped)-JS` for observable effects
  (return value, console, thrown error). Any input program then becomes an oracle; plug in these
  corpora (all permissive licenses — vendor with attribution):
  1. **ts-evaluator's tests** (MIT) — same domain (TS-AST interpreter runtime); the **executor-
     regression oracle** proving the recursive→stack rewrite preserved behavior.
  2. **TypeScript `tests/cases/`** (Apache-2.0) — thousands of programs. NOTE: these test the
     *compiler* (types/emit/errors), so use them as differential-test **inputs**, not native pass/fail.
     Best oracle for runtime-emit constructs (enum/namespace/decorators/param-properties).
  3. **test262** (BSD-3) — deep ECMAScript semantics for the long tail (TDZ, closures, generators,
     async). Huge → sample/bucket.
  4. **sval's tests** — extra JS coverage, free.
  Dev loop: run corpus → bucket failures by `SyntaxKind` → implement to close gaps (throw on
  unimplemented, grow against the corpus).
- **S1 — Skeleton VM, parse-only.** `ts.createSourceFile` front-end + `enumerateReverseLookup`. Build
  the value/control stacks + `step()` loop for a core subset (literals, identifiers, binary, var/let/
  const, block+scoping, if, call, function, return) — enough to run `fetch("https://x")` end to end.
- **S2 — Coverage.** loops, closures, `this`, member/assignment, destructuring, spread, optional
  chaining, classes/super, `try/finally`, labeled break, switch. Drive with sval's corpus.
- **S3 — Stepping + async.** `step`/`stepStatement`/`runUntil`/breakpoints; async/await + generators as
  machine suspension.
- **S4 — Snapshot / fork.** `clone()` with the host-object-sharing strategy.
- **S5 — Capability shims + canary.** Inject recording/deny shims (net first; reuse
  `lib/util/silo/reach.ts` matcher config to know what to shim). Divergence predicate
  `runtime-caps ⊆ static-caps` → hard abort + review. Wire to silo `guard`/`review`/`runs` if
  integrating.
- **S6 — Type-aware.** Add `TypeChecker` (typescript now, TS 7.1 later); type-directed canary
  ("a value assignable to `RequestInfo` flowed into a sink").

## 6. Prior art — DumbLang (the user's 2020–21 attempt)

`~/Library/Mobile Documents/com~apple~CloudDocs/Code/DumbLang/` (`dlc/interpreter.ts`, `scope.ts`,
`index.ts`; `reference.ts`/`reference2.ts` are ESTree evaluators). A **recursive** tree-walker over the
**native tsc SyntaxKind** AST, ~20% node coverage (rest `throw`). It is a partial version of exactly
this Path-B interpreter — **the semantics cheat-sheet for the SyntaxKind dispatch**, plus the
`enumerateReverseLookup` gotcha. Its scope-restoration bug (shared mutable `scope`, never restored) is
the concrete argument for explicit per-frame environments; our VM eliminates the class of bug.

## 7. Remaining open decisions

1. **AST-walk + continuation stack (recommended) vs bytecode VM** — start with the former (no compile
   pass, clean source-mapping); revisit bytecode only if perf demands.
2. **When to add the `TypeChecker`** — parse-only through S5, type-aware at S6 (recommended), vs typed
   from S1 (heavier, blocks early progress).
3. **`typescript` (JS, heavy, available now) vs TS 7.1 native (WASM, faster, ~Sept 2026)** as the
   Path-B backend — start with `typescript` for availability; keep the parser a swappable seam.
4. **Home & name** — fold into `lib/util/silo/` (silo's dynamic layer) or publish standalone
   (`@brianjenkins94/tsval`?). Undecided until the design converges.

## 8. Concrete first move

```
S0: new repo + vendor sval Scope/Var/Prop + snippet→Node diff harness.
S1: ts.createSourceFile front-end; value/control stacks + step() loop for the core subset;
    run `const u = "https://x"; fetch(u)` and observe the injected fetch shim receive it.
```

sval reference clone: v0.6.12 (`58550fd`), MIT — re-clone `https://github.com/Siubaak/sval` if needed.
