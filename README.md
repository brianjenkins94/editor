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

## Layout

- `src/` — the VM (`vm.ts`), per-SyntaxKind handlers (`handlers.ts`), scope (`scope.ts`), front-end
  (`frontend.ts`).
- `test/differential/` — the differential oracle: tsval output vs Node output on the same program.
- `vendor/ts-evaluator/` — [ts-evaluator](https://github.com/wessberg/ts-evaluator) (MIT), used as the
  per-node **semantics spec** and a test **oracle**, not shipped as a dependency.

## License

MIT.
