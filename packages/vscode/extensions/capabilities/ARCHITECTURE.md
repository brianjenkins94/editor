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
  │   ts-plugin.js  ──loads──▶ capabilities-engine.js  (DETECT: util/silo findReach, oxc)                        │
  │                 ──loads──▶ capabilities-canary.js  (RESOLVE: tsval, at beforeCall)                           │
  │   → emits native ts.Diagnostics (source "capabilities")   ◀── the ONLY clean channel out of tsserver        │
  ├───────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ ext host (the extension)                                                                                     │
  │   extension.ts  reads those diagnostics + .silo/policy.json → PANEL (dispositions, editing)                  │
  │                 TRIPWIRE (surface): a denied call → its own error diagnostic (source "capabilities-policy")  │
  │   policy.ts     the vscode file I/O for the base .silo/policy.json (the panel edits the contract)            │
  │   silo-store.ts the .silo/ layout: base+override merge · observed rollup · run firehose  (decide.ts uses it) │
  ├───────────────────────────────────────────────────────────────────────────────────────────────────────────┤
  │ run contexts (where ENFORCE lives — plural, because the app runs in different runtimes)                      │
  │   tsval debugger  (worker-pod: debug-adapter.ts + debug-worker.ts)  → HARD-STOP breakpoint  [wiring: TODO]   │
  │   almostnode      (worker-pod: node-worker.ts, "production")        → block / mock at shim  [TODO]           │
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
  <user>.policy.json        DECISIONS · mine      per-user overrides — the "Allow always" popup writes here; committed, conflict-free
  capabilities.json         FACTS · static        what analysis (findReach) says code CAN do
  <user>.capabilities.json  FACTS · observed      what actually FIRED for this user — a day-coarsened rollup
  <user>.runs.jsonl         FACTS · observed      raw observation firehose — the exposure ledger (gitignored)
  .gitignore                silo-managed          ignores *.runs.jsonl
```

Enforcement reads the **effective** policy = `<user>.policy.json` layered over `policy.json` (override wins,
contract next, computed default last). Timestamps land per axis: `added` (when I authorized) on the override rule;
`firstObserved`/`lastObserved` on the observed rollup; the fine-grained stream in `<user>.runs.jsonl`. "lastAllowed"
and "was I exposed to compromised dep X in window W" are QUERIES over the observed side, never stored decision state.
`silo-store.ts` owns all of this I/O; `policy.ts` handles only the base file the panel curates.

## Files (what lives where)

| file | role | runs in |
| --- | --- | --- |
| `@brianjenkins94/util/silo/policy` | pure policy model: `Policy`/`Rule`, `effectiveDisposition`, `findRule`, `matchesResource`, edits, `DANGEROUS`/`isDangerous` (shared with silo; was the local `policy-core.ts` fork) | anywhere (pure) |
| `capability-breakpoints.ts` | pure call model: `classifyCall`, `shouldBreak`, `findCapabilitySites`, `renderCallee` | anywhere (needs only `ts` types) |
| `engine.ts` → `capabilities-engine.js` | DETECT — util/silo `findReach` (oxc) | tsserver plugin |
| `canary.ts` → `capabilities-canary.js` | RESOLVE — tsval run, observes pre-call values (ts **external**, reuses tsserver's) | tsserver plugin |
| `ts-plugin.js` | loads both engines, runs the canary in the background, merges results into diagnostics | tsserver plugin |
| `ts-external.js` | the `typescript` shim (`= globalThis.__capabilitiesTs`) that lets the canary reuse tsserver's ts | build only |
| `extension.ts` | the "Capability calls" panel + the tripwire error-surface | ext host |
| `policy.ts` | vscode read/write of the base `.silo/policy.json` the panel curates (wraps `silo/policy`) | ext host |
| `silo-store.ts` | the whole `.silo/` layout: base+override policy merge, observed rollup, run firehose, git-user resolution | ext host |
| `decide.ts` | the single capability decision endpoint every interceptor round-trips to (classify → gate → decide) | ext host |

## Invariants (keep these true)

- **One classifier.** `capability-breakpoints.classifyCall` is THE way to decide "is this a capability, what
  resource." The canary uses it (AST-primary); its injected stand-ins carry tags only as an *aliasing fallback*
  (`const f = fetch; f(url)`), never as a second classifier. A new runtime uses `classifyCall` too.
- **One policy model.** `@brianjenkins94/util/silo/policy` is the single source of dispositions + matching (shared
  with silo, no longer a local fork); `silo-store` is the single source of `.silo/` I/O (base+override merge,
  observed facts). `policy.ts` only adds the panel's base-file I/O.
- **Diagnostics are the bus out of tsserver.** Anything the plugin needs to tell the UI rides a `ts.Diagnostic`.
- **One decision endpoint; thin interceptors.** Every runtime interceptor (the service-worker net gate, the
  almostnode fs/exec shim hook) is dumb and full-round-trips to `decide.ts` (`classify → gate → decide`); no
  policy, grant store, or prompt lives in an interceptor. The net gate runs *in* the service worker (that's where
  a preview `fetch` can be stopped) but decides nothing itself — it asks `decide.ts` over the hub, same as fs/exec.
  This is what keeps net + fs + exec uniform without duplicating the brain.

## Status

- **Done:** DETECT + RESOLVE (in tsserver, `capabilities-canary.js` ~0.17MB by reusing tsserver's ts) · SURFACE
  (panel with allow/deny/review dispositions + a view badge) · TRIPWIRE surface (denied call → error squiggle) ·
  the pure core (`policy-core`, `capability-breakpoints`) · unified classification · ENFORCE round-trip
  (`decide.ts` endpoint; net gate in the SW, fs write/delete + read gate in the almostnode shim) · the `.silo/`
  layout (`silo-store.ts`: base+override policy, observed rollup, run firehose) · production debug adapter.
- **Next:** persist the STATIC surface to `.silo/capabilities.json` (the panel/engine side) so static-vs-observed
  drift is queryable · run-grain records in `<user>.runs.jsonl` (correlate a run's entry/sha with the scopes it
  exercised, for the "was I exposed to compromised dep X" audit) · the elicitation/AI decider behind the
  `policyDecider` seam · `gate`/`mock` dispositions.
