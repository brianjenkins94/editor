# tsval — progress log

Append-only-ish log so the next session inherits decisions + state. Newest stage on top.
See [`ASSIGNMENT.md`](./ASSIGNMENT.md) for the mission and staged plan; this file records what's *done*.

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

### Still open for S2
- **Classes / super** (next), `new` for guest classes, object-literal methods/accessors.
- Assignment destructuring targets (`[a,b] = x`; declaration destructuring is done).
- Recursive `var` hoisting into nested blocks/loops (hoist is still shallow).
- Then S3 (stepping API + async/generators), S4 (snapshot/fork), S5 (shims + canary), S6 (types).

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
