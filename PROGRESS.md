# tsval — progress log

Append-only-ish log so the next session inherits decisions + state. Newest stage on top.
See [`ASSIGNMENT.md`](./ASSIGNMENT.md) for the mission and staged plan; this file records what's *done*.

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
