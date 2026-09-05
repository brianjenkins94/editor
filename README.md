# tsval

A **stepped, stack-based, TypeScript-AST interpreter**. It walks the native TypeScript compiler AST
(`ts.SyntaxKind`, "Path B") and executes it on an explicit continuation-stack VM — not host recursion
— so it can single-step, pause/resume, and snapshot/fork execution state.

This repository is the interpreter only. It exposes the seams a host builds on — a host-boundary
guard that sees every value and every callable crossing from the host, an `import` resolver, an
async-invocation hook, fork, breakpoints, an optional TypeChecker — and takes no position on what a
host does with them. (The capability canary that originally motivated those seams lives in its own
repository.) See [`ASSIGNMENT.md`](./ASSIGNMENT.md) for the original design brief and
[`PROGRESS.md`](./PROGRESS.md) for current status.

## Requirements

Node ≥ 24 (runs `.ts` natively — no build step).

```bash
npm install
npm test            # unit + differential oracle
npm run typecheck   # tsc --noEmit
```

## Usage

```ts
import { interpret, createVM } from "./src/index.ts";

// Run to completion (returns the last expression's value).
interpret(`const a = 1; const b = 2; a + b`); // => 3

// The guest sees only the standard built-ins unless a host adds more.
const seen = [];
interpret(`fetch("https://x")`, { globals: { fetch: (u) => seen.push(u) } }); // without `globals`: ReferenceError

// Single-step and inspect the machine between steps.
const vm = createVM(`const n = 1 + 2; n * 10`);
while (!vm.finished) {
  vm.stepStatement();          // or vm.step() for one unit of work
  console.log(vm.values, vm.frames.length);
}
vm.completion; // => 30
```

## Supported surface

tsval runs **strict-mode ECMAScript plus erasable TypeScript** — the language a TypeScript *module*
is written in, and the surface Node's own type-stripping accepts. Anything outside that is refused
**loudly** (a `TsvalInternalError` naming the construct), never silently mis-run:

- Strict-mode semantics throughout: top-level and plain-call `this` are `undefined`; assigning to an
  undeclared name is a `ReferenceError` (no implicit globals); a function declaration in a block is
  block-scoped; `undefined`/`NaN`/`Infinity` are read-only.
- Out of scope by policy: sloppy-mode-only behavior (`with`, implicit globals, function-in-block
  lifting), legacy `experimentalDecorators` (non-standard; standard TC39 decorators are not modeled
  either, and sharing their syntax is exactly why neither is half-implemented), parameter properties,
  `namespace`, `import =`.
- Retained non-erasable construct: `enum` (runtime-emit, differentially verified against `tsc`).
- **A program sees only what it is given.** The default global object is ECMAScript's standard
  namespace (`standardGlobals()`: `Object`, `Math`, `JSON`, `Promise`, `Intl`, …) and none of the
  host's — no `process`, `require`, `fetch`, timers or `console`, and no `eval`. A host adds what it
  wants through `globals`, supplies a whole realm through `globalObject`, or asks for the host's
  real `globalThis` with `realGlobals: true` (what the differential oracle does, for parity with Node).

The differential oracle runs Node in strict mode with an undefined receiver to match.

## Host seams

```ts
import { interpret, createVM } from "./src/index.ts";

interpret(code, {
  hostGuard: {
    sanitize: (value) => value,                 // every host→guest value crossing (property reads, returns, awaited values)
    beforeCall: (callee, thisArg, isNew) => callee, // every host callable the guest invokes (replace, wrap, or refuse)
  },
  resolveModule: (specifier) => namespace,      // what `import` / `import()` resolve to
  onAsyncFiber: (promise) => {},                // every async function / async-generator invocation
});

const vm = createVM(code);
vm.runUntil((m) => m.steps > 1_000);           // step budgets, breakpoints (vm.location, vm.breakpoints)
const fork = vm.fork();                        // an independent copy of the machine state, mid-expression if need be
```

Guest→guest calls never touch the host stack, so a guard cannot be bypassed from inside the guest;
`[].constructor.constructor` reaches the guard like any other read.

## TypeScript's own test cases

The TypeScript repository's `tests/cases/{compiler,conformance}` (Apache-2.0, ~12k programs, pinned
to the `typescript` version tsval uses) are wired in as differential *inputs*: they test the
compiler and assert nothing at runtime, so tsc's emit running in Node is the oracle and tsval on the
TypeScript source is the subject. Single-file, non-module, syntactically clean programs within the
supported surface are eligible (~5.3k); the agreement is 99.9%, with the remaining cases listed by
reason in `test/differential/ts-cases-gaps.ts`. Cases run in a child process, because some of them
were never meant to run (one spreads an infinite iterator). A 1-in-10 sample is checked in and runs
in `npm test`; `npm run ts-cases:fetch` and `npm run ts-cases:report` run the full corpus.

## Conformance: test262

The official ECMAScript conformance suite ([tc39/test262](https://github.com/tc39/test262), BSD-3)
is wired in as an oracle, with Node as the control. The supported-surface policy is applied as a
*filter* on its metadata: `noStrict`, `module` and `raw` tests, parse-phase negatives, and host-level
features are skipped by policy; everything else must pass, be inconclusive (Node fails it too), or be
a listed known gap (run as `todo`).

- `vendor/test262-sample/` is checked in: a deterministic 1-in-25 sample of the eligible
  `test/language` tests (~650), run by `npm test` as an always-on regression corpus.
- `npm run test262:fetch` pulls the full pinned checkout (98 MB, gitignored) into `vendor/test262/`;
  `npm run test262:report` runs all ~16k eligible tests and prints failures bucketed by directory and
  reason — the dev loop for finding the next bug.

Each side of each test runs in a **fresh realm** (`node:vm` context): test262 mutates builtins on
purpose, and tsval creates guest values with the guest realm's intrinsics so `[] instanceof Array`,
`Object.getPrototypeOf({})`, `"".constructor` and a generator's prototype chain agree with the
guest's own `Array`/`Object`/`String`/`%GeneratorFunction%`.

test262's language tests are *scripts*, so the runner passes the realm's global object as the
top-level `this` (`VMOptions.thisValue`) and installs `$DONE` as a global property; tsval's default
remains module semantics (top-level `this` is `undefined`, top-level bindings are not globals).
Current standing on the full pinned corpus: **99.9 % of eligible tests pass**; the remaining 11
failures all concern exact microtask ordering (`await` interleaving, async-generator ticks), which
follows the host promise queue today — see the open scheduler decision in `PROGRESS.md`.

Every destructuring pattern, parameter list and catch parameter is compiled once to a small list
of plain-data ops run by a synthetic `pattern` frame; defaults, computed keys and member targets
are ordinary node frames above it, so `const [a = yield] = it` or `[o[await k]] = v` suspend like
anything else, and a fork taken in the middle of a pattern is ordinary frame state.

## Layout

- `src/` — the VM (`vm.ts`), the frame types (`frame.ts`), scope (`scope.ts`), front-end
  (`frontend.ts`); the per-SyntaxKind handlers live under `src/handlers/` by concern (registry,
  realm boundary, hoisting, iteration, references, operators, literals, functions, calls,
  generators, statements, classes, patterns) — `src/handlers.ts` registers them all.
- `test/differential/` — the differential oracle: tsval output vs Node output on the same program.
- `vendor/ts-evaluator/` — the test corpus of [ts-evaluator](https://github.com/wessberg/ts-evaluator) (MIT),
  differential-oracle input; nothing of it is shipped or imported.

## License

MIT.
