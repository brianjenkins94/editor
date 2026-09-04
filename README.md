# tsval

A **stepped, stack-based, TypeScript-AST interpreter**. It walks the native TypeScript compiler AST
(`ts.SyntaxKind`, "Path B") and executes it on an explicit continuation-stack VM — not host recursion
— so it can single-step, pause/resume, and (planned) snapshot/fork execution state.

It is the dynamic half of a capability-analysis system: a static kernel predicts which capabilities a
file reaches; tsval will later run the code with injectable capability shims and hard-abort on any
runtime divergence from that prediction (the "canary"). Stepping and snapshot/fork are what make that
possible — which is why tsval is a fresh stack VM rather than a reuse of an existing one-shot
tree-walker. See [`ASSIGNMENT.md`](./ASSIGNMENT.md) for the full design and [`PROGRESS.md`](./PROGRESS.md)
for current status.

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

// Inject a capability shim and observe what it receives.
const seen = [];
interpret(`fetch("https://x")`, { globals: { fetch: (u) => seen.push(u) } });

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

The differential oracle runs Node in strict mode with an undefined receiver to match.

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
purpose, and tsval creates guest values with the guest realm's intrinsics so `[] instanceof Array`
and `Object.getPrototypeOf({})` agree with the guest's own `Array`/`Object`.

## Layout

- `src/` — the VM (`vm.ts`), per-SyntaxKind handlers (`handlers.ts`), scope (`scope.ts`), front-end
  (`frontend.ts`).
- `test/differential/` — the differential oracle: tsval output vs Node output on the same program.
- `vendor/ts-evaluator/` — [ts-evaluator](https://github.com/wessberg/ts-evaluator) (MIT), used as the
  per-node **semantics spec** and a test **oracle**, not shipped as a dependency.

## License

MIT.
