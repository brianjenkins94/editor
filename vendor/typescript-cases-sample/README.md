# TypeScript compiler test cases — sample

A deterministic 1-in-10 sample of the policy-eligible cases from
[microsoft/TypeScript](https://github.com/microsoft/TypeScript) `tests/cases/{compiler,conformance}` at tag `v5.9.3`
(Apache-2.0, see LICENSE.txt and ThirdPartyNoticeText.txt). Used as differential INPUTS (tsval vs tsc-emit-in-Node);
the cases themselves assert nothing at runtime. Regenerate with `npm run ts-cases:fetch && npm run ts-cases:sample`.
584 of 5837 eligible cases.
