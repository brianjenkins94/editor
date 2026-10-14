# The capability plane

The capability IDE is **one pipeline with one shared core**. Every capability call goes through the same four
steps; two pure "core" modules answer *"what is this, and what should happen"*, and each runtime just **consumes**
the core at its own call boundary. Hold to that and the seams stay put.

```
                           ┌──────────────────────── THE CORE (pure; no vscode / node / oxc) ───────────────────┐
                           │  silo/policy (util)          dispositions, rules, resource matching  → .silo/ layout
                           │  capability-breakpoints.ts   classifyCall(node,args) · shouldBreak(policy) · findSites
                           └──────────────────────────────────────────────────────────────────────────────────┘
                                        ▲ consumed by every stage / runtime ▲

  DETECT ───────────▶ RESOLVE ───────────▶ SURFACE ───────────▶ ENFORCE
  static call sites   concrete runtime      show + disposition    act at run time
                      resource

  where each lives:
  ┌───────────────────────────────────────────────────────────────────────────────────────────────────────────┐
  │ tsserver plugin (in-browser tsserver, ts reused, ~free)                                                      │
  │   ts-plugin.js  ──loads──▶ capabilities-engine.js  (DETECT: util/silo findReach, on tsserver's tree)         │
  │                 ──loads──▶ capabilities-canary.js  (RESOLVE: tsval, at beforeCall)                           │
  │   → answers requests only: _capabilities.findings / .surface, _types.at, _statements (tsserverRequest)    │
  ├───────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ ext host (the extension)                                                                                     │
  │   findings.ts   asks _capabilities.findings → its own diagnostics (source "capabilities"): squiggles      │
  │   extension.ts  reads those diagnostics + .silo/policy.json → PANEL (dispositions, editing)                  │
  │                 TRIPWIRE (surface): a denied call → its own error diagnostic (source "capabilities-policy")  │
  │   policy.ts     the vscode file I/O for the base .silo/policy.json (the panel edits the contract)            │
  │   silo-store.ts the .silo/ layout: base+override merge · observed rollup · run firehose  (decide.ts uses it) │
  ├───────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ run contexts (where ENFORCE lives — plural, because the app runs in different runtimes)                      │
  │   tsval debugger  (tsval: debug-adapter.ts + debug-worker.ts)  → HARD-STOP breakpoint that ASKS on its   │
  │                   line (allow once / always / deny, in the notes margin: LIVE-VALUES.md step 8)              │
  │   almostnode      (workers/node-worker.ts, "production")        → block / mock at shim  [TODO]           │
  │        both consume capability-breakpoints (classifyCall + shouldBreak) at beforeCall / the shim boundary    │
  └───────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

## The two channels carry everything

- **diagnostics** (`source: "capabilities"`) — the only clean way data leaves the tsserver worker. DETECT + RESOLVE
  publish them; SURFACE (panel, tripwire) reads them back. No sentinel, no hub, no side channel.
- **the `.silo/` layout** (workspace root, or the nearest `.silo/` walking up — monorepo-ready) — the on-disk
  capability state. Policy-as-code: human-readable, git-reviewable, in the explorer.

## The `.silo/` layout

Two independent axes, and each axis's halves are kept in separate files because the **gap between them is the
signal** (a scope OBSERVED with no matching STATIC entry is the alarm; silo must never rewrite the human contract).

```
.silo/
  policy.json               DECISIONS · base      the shared contract — human-authored (panel edits it; silo never writes)
  policy/<user>.json        DECISIONS · mine      per-user overrides — the "Allow always" popup writes here; committed, conflict-free
  capabilities.json         FACTS · static        what analysis (findReach) says code CAN do
  capabilities/<user>.json  FACTS · observed      what actually FIRED for this user — a day-coarsened rollup
  runs/<user>.jsonl         FACTS · observed      the run ledger (evidence.ts): each run's envelope, with its `effects`
  baseline.json             FACTS · static        what each dependency's own code can do, by static analysis, as libraries are
                                                  added (baseline.ts: made as the project opens, synced as versions.json —
                                                  the dependencies — changes, read in the package worker; what a newer version can do more is in `grew`, with the
                                                  version that grew it — it asks at the call unless the policy allows it;
                                                  `consumer`: the code's use of each, with the join — what the part it uses
                                                  can reach — and what grew there, with the members that brought it in).
                                                  Never taught by runs.
  .gitignore                silo-managed          ignores local/
```

Enforcement reads the **effective** policy = `policy/<user>.json` layered over `policy.json` (override wins,
contract next, computed default last). Timestamps land per axis: `added` (when I authorized) on the override rule;
`firstObserved`/`lastObserved` on the observed rollup; each run's own in its envelope's `effects` (a debug run's from
its worker, a preview's from `decide`, counted by run in `silo-store.ts` and asked for over `run.effects` as the
envelope is written). "lastAllowed"
and "was I exposed to compromised dep X in window W" are QUERIES over the observed side, never stored decision state.
`silo-store.ts` owns all of this I/O; `policy.ts` handles only the base file the panel curates.

## Files (what lives where)

| file | role | runs in |
| --- | --- | --- |
| `@brianjenkins94/util/silo/policy` | pure policy model: `Policy`/`Rule`, `effectiveDisposition`, `findRule`, `matchesResource`, edits, `DANGEROUS`/`isDangerous` (shared with silo; was the local `policy-core.ts` fork) | anywhere (pure) |
| `capability-breakpoints.ts` | pure call model: `classifyCall`, `shouldBreak`, `capabilityBreakLines`, `renderCallee` | anywhere (needs only `ts` types) |
| `engine.ts` → `capabilities-engine.js` | the readings, over whatever holds the tree (its `ts`, SourceFile, checker): `findings` (util/silo `findReach`, typed, merged with the canary's observations), `surface`, and lib `typed`'s `typesAt` / `statementsOf` | tsserver plugin |
| `canary.ts` → `capabilities-canary.js` | RESOLVE — tsval run, observes pre-call values (ts **external**, reuses tsserver's) | tsserver plugin |
| `ts-plugin.js` | loads both engines, runs the canary in the background, and answers requests with the engine's readings — nothing injected into tsserver's own diagnostics | tsserver plugin |
| `findings.ts` | asks `_capabilities.findings` for each open document (as it opens and its edits settle; again while the canary runs) and shows them as this extension's own diagnostics | ext host |
| `ts-external.js` | the `typescript` shim (`= globalThis.__capabilitiesTs`) that lets the canary reuse tsserver's ts | build only |
| `extension.ts` | the "Capability calls" panel + the tripwire error-surface | ext host |
| `baseline.ts` | keeps `.silo/baseline.json` up to `.silo/versions.json` (the workbench's resolver): new or changed packages read in the package worker, lib's `syncPackages`; and its `consumer` — the code's use of its dependencies — from every file's import surface (`_capabilities.surface`, the plugin's), each entry with its join (the slice's caps, kept while version, members and dynamic use are unchanged), synced as code changes through lib's `syncConsumer` (growth from code is recorded with the members that brought it in); off with `silo.baseline` | ext host |
| `packages-worker.ts` → `lsp/packages-worker.js` | READ — each package's tarball through lib's `packageCaps` (code files, install hooks), and the join: lib's `sliceCaps` with `@rolldown/browser` (loaded on the first slice) for each spec the code imports; a slice that can't be built is null, the whole package stands; started for a sync, ended after | a worker of the extension's |
| `exceptions.ts` | the "Exceptions" view: libraries that grew a capability (the baseline's `grew`), and the policy's exceptions — each run's answers at the call (`decided`: once / always / refused), by package or the program | ext host |
| `policy.ts` | vscode read/write of the base `.silo/policy.json` the panel curates (wraps `silo/policy`) | ext host |
| `silo-store.ts` | the whole `.silo/` layout: base+override policy merge, observed rollup, run firehose, git-user resolution | ext host |
| `decide.ts` | the single capability decision endpoint every interceptor round-trips to (classify → gate → decide) | ext host |

## Baseline, policy, exceptions

The baseline is what each library's own code can do (static analysis, as it's added). The policy is the default stance
on a call beyond it: allow, deny, or ask — and it can be about a package as a whole: an org's contract bans a package
(it doesn't run at all) or trusts one (its calls aren't asked about); a deny wins over an allow (lib's
`packageDisposition`). In a debug run, a package's call is decided at the call: trusted → made; within its baseline →
made (lib's `settledReach`: the joins of what the code imports of it, else the whole package; only while the
baseline's version is the one running); else the editor decides (`decide` on the runtime mailbox → decide.ts: redline → the policy → the prompt). The
answer at a prompt is an exception to the policy, recorded in the run (an effect's `decided`); "Allow always" also adds
a rule to the person's policy; "Allow once" lasts the run.

## Invariants (keep these true)

- **One classifier.** `capability-breakpoints.classifyCall` is THE way to decide "is this a capability, what
  resource." The canary uses it (AST-primary); its injected stand-ins carry tags only as an *aliasing fallback*
  (`const f = fetch; f(url)`), never as a second classifier. A new runtime uses `classifyCall` too.
- **One fs table.** Which `fs` methods read and which write is `@brianjenkins94/almostnode/fs-capabilities` — the
  table the runtime shim gates by. `classifyCall`'s matchers, the canary's stand-ins and `decide.ts`'s lookup all
  derive from it, so the editor never misses a method the runtime asks about (as `rm` / `rename` / `copyFile` once
  were).
- **One policy model.** `@brianjenkins94/util/silo/policy` is the single source of dispositions + matching (shared
  with silo, no longer a local fork); `silo-store` is the single source of `.silo/` I/O (base+override merge,
  observed facts). `policy.ts` only adds the panel's base-file I/O.
- **The plugin only answers.** Everything it computes is the engine's (lib's readings over the host's tree); the extension asks with `typescript.tsserverRequest` and shows what comes back. So moving to TypeScript 7 is one adapter — its API connection answering the same requests (the silo README's "Where analysis lives when TypeScript 7 arrives").
- **One decision endpoint; thin interceptors.** Every runtime interceptor (the service-worker net gate, the
  almostnode fs/exec shim hook) is dumb and full-round-trips to `decide.ts` (`classify → gate → decide`); no
  policy, grant store, or prompt lives in an interceptor. The net gate runs *in* the service worker (that's where
  a preview `fetch` can be stopped) but decides nothing itself — it asks `decide.ts` over the hub, same as fs/exec.
  This is what keeps net + fs + exec uniform without duplicating the brain.

## Status

- **Done:** DETECT + RESOLVE (in tsserver, `capabilities-canary.js` ~0.17MB by reusing tsserver's ts) · SURFACE
  (panel with allow/deny/review dispositions + a view badge) · TRIPWIRE surface (denied call → error squiggle) ·
  the pure core (`@brianjenkins94/util/silo/policy`, `capability-breakpoints`) · unified classification · ENFORCE round-trip
  (`decide.ts` endpoint; net gate in the SW, fs write/delete + read gate in the almostnode shim) · the `.silo/`
  layout (`silo-store.ts`: base+override policy, observed rollup, each run's effects) · production debug adapter.
- **Next:** persist the STATIC surface to `.silo/capabilities.json` (the panel/engine side) so static-vs-observed
  drift is queryable · the "was I exposed to compromised dep X" audit, a query over the run ledger (each envelope has its
  files' oids and its effects) · the elicitation/AI decider behind the
  `policyDecider` seam · `gate`/`mock` dispositions.
