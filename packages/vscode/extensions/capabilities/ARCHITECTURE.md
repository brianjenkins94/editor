# The capability plane

The capability IDE is **one pipeline with one shared core**. Every capability call goes through the same four
steps; two pure "core" modules answer *"what is this, and what should happen"*, and each runtime just **consumes**
the core at its own call boundary. Hold to that and the seams stay put.

```
                           ┌──────────────────────── THE CORE (pure; no vscode / node / oxc) ───────────────────┐
                           │  policy-core.ts              dispositions, rules, resource matching  → .capabilities.json
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
  │   extension.ts  reads those diagnostics + .capabilities.json → PANEL (dispositions, editing)                 │
  │                 TRIPWIRE (surface): a denied call → its own error diagnostic (source "capabilities-policy")  │
  │   policy.ts     the vscode file I/O for .capabilities.json                                                   │
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
- **`.capabilities.json`** (workspace root) — the policy. Written by the ext host; read by the ext host and by each
  run context. Policy-as-code: human-readable, git-reviewable, in the explorer.

## Files (what lives where)

| file | role | runs in |
| --- | --- | --- |
| `policy-core.ts` | pure policy model: `Policy`/`Rule`, `effectiveDisposition`, `findRule`, `matchesResource`, edits | anywhere (pure) |
| `capability-breakpoints.ts` | pure call model: `classifyCall`, `shouldBreak`, `findCapabilitySites`, `renderCallee` | anywhere (needs only `ts` types) |
| `engine.ts` → `capabilities-engine.js` | DETECT — util/silo `findReach` (oxc) | tsserver plugin |
| `canary.ts` → `capabilities-canary.js` | RESOLVE — tsval run, observes pre-call values (ts **external**, reuses tsserver's) | tsserver plugin |
| `ts-plugin.js` | loads both engines, runs the canary in the background, merges results into diagnostics | tsserver plugin |
| `ts-external.js` | the `typescript` shim (`= globalThis.__capabilitiesTs`) that lets the canary reuse tsserver's ts | build only |
| `extension.ts` | the "Capability calls" panel + the tripwire error-surface | ext host |
| `policy.ts` | vscode read/write of `.capabilities.json` (wraps `policy-core`) | ext host |

## Invariants (keep these true)

- **One classifier.** `capability-breakpoints.classifyCall` is THE way to decide "is this a capability, what
  resource." The canary uses it (AST-primary); its injected stand-ins carry tags only as an *aliasing fallback*
  (`const f = fetch; f(url)`), never as a second classifier. A new runtime uses `classifyCall` too.
- **One policy model.** `policy-core` is the single source of dispositions + matching. `policy.ts` only adds I/O.
- **Diagnostics are the bus out of tsserver.** Anything the plugin needs to tell the UI rides a `ts.Diagnostic`.
- **Enforce at the call boundary.** Every run context enforces at its own `beforeCall` / shim seam by consuming
  the core — NOT via a separate per-capability mechanism. (This is why the service-worker net-block was dropped:
  it was a special case for `net`; the boundary seam covers net + fs + exec uniformly.)

## Status

- **Done:** DETECT + RESOLVE (in tsserver, `capabilities-canary.js` ~0.17MB by reusing tsserver's ts) · SURFACE
  (panel with allow/deny/review dispositions + a view badge) · TRIPWIRE surface (denied call → error squiggle) ·
  the pure core (`policy-core`, `capability-breakpoints`) · unified classification.
- **Next:** ENFORCE for real — wire `capability-breakpoints` into `debug-worker.ts` so a gated call hard-stops the
  tsval debugger at the line (with step-back); **auto-attach** so a terminal run *is* a debug session; then the
  almostnode "production" shim enforcement (forward-only). `gate`/`mock` dispositions + elicitation-at-the-stop
  come with enforcement.
