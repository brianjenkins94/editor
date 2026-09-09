# ts-evaluator test corpus

The `test/` directory of [ts-evaluator](https://github.com/wessberg/ts-evaluator) v2.0.0 (wessberg,
MIT — see LICENSE.md), vendored as differential-oracle INPUT: its test programs run through tsval and
through Node, and the two must agree (`test/differential/ts-evaluator.test.ts`). Only the tests are
kept; ts-evaluator's own source served as a per-node semantics reference while the interpreter was
built and is not shipped or read by anything here.
