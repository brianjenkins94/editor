// PROTOTYPE (perf) — neutralize @bablr/record + agast-helpers deep-freezing inside a BABLR parse worker.
//
// BABLR builds every CST tag and node as a deep-frozen, null-prototype record. Profiling the shipped bundle (with
// @bablr/record's `validate` walk already tree-shaken out) shows the remaining freeze calls — agast-helpers'
// `freezeRecord` + the record shim's `fastFreezeRecord` — are ~27% of parse SELF-time and drive most of the GC
// churn. Freezing is a mutation-safety guard, not a correctness requirement for a single parse: the round-trip
// corpus is byte-identical with freezing off (150/150 cases, same 2 pre-existing grammar gaps), and a 280 KB
// cstSpans dump matches freeze-on exactly. Neutralizing it buys ~17% wall-clock on the production bundle.
//
// WHY A SEPARATE, FIRST-IMPORTED MODULE. agast-helpers captures `freeze`/`isFrozen` off the global `Object` at its
// own module-load time (`export const { freeze, isFrozen } = Object`). Static ES imports are hoisted and evaluated
// depth-first in source order, so this side-effecting module — imported BEFORE any module that transitively loads
// BABLR — runs first and installs the no-ops before agast snapshots them. A statement at the top of the worker
// body would run too late (after the imported bundle has already been evaluated).
//
// WHY IT'S SAFE HERE (and why it is NOT viable as a global patch / bundle banner). This overrides the SHARED
// `Object.freeze`/`Object.isFrozen` of whatever realm evaluates it, so it may only run in a realm that contains
// nothing but BABLR. Dedicated parse workers (classify-worker, game-worker) are exactly that. It must NOT be baked
// into the bablr bundle itself, because the bundle is also imported on the main thread (git-engine's cheap,
// parse-free `isCommitBoundary`), and polluting the main realm's `Object.freeze` would affect every other library.
//
//   - `Object.freeze` → identity: records are no longer frozen (the ~27% + GC we want back).
//   - `Object.isFrozen` → true: the agast-helpers / @bablr/btree invariant assertions (`assert isFrozen(node)` at
//     path.js / evaluate.js / context.js) still pass against the now-unfrozen records. Without this the parse
//     throws — it is why the historical measurement shim (bablr-language-ts/test/nofreeze.mjs) also faked it.
//   - `setPrototypeOf` is left ALONE: @bablr/btree asserts null-prototype records, and freezeRecord still calls
//     `setPrototypeOf(obj, null)`. Only the freeze half is removed.
Object.freeze = ((value: unknown) => value) as typeof Object.freeze;
Object.isFrozen = (() => true) as typeof Object.isFrozen;
