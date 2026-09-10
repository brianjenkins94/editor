// W5 measurement shim (`--fast` in the harness) — NOT viable in production: agast-helpers/bablr-vm assert
// `isFrozen` (path.js:116 at module load, evaluate.js:124, context.js:74…), so freezing must stay.
// The BABLR runtime spends ~40% of parse time validating and freezing records; this removes the checking only.
// Upstream fix: a runtime build or flag without deep-freeze validation. `setPrototypeOf(null)` must stay:
// @bablr/btree asserts null prototypes. Verified byte-identical output on all corpus cases.
// Experiment preload: make freezing a no-op to measure its cost.  node --import ./test/nofreeze.mjs …
Object.freeze = (obj) => obj;
Object.isFrozen = () => true;
