# silo

Silo is everything that should exist when trying to build software safely in the 21st century. It does four jobs:

1. **Anticipate.** Static analysis (and deobfuscation) works out what a package might need.
2. **Track.** It records what each package needs over time, to protect you from a compromised one.
3. **Remember.** It keeps your policy and a record of your runs, to understand the coverage and growth of your program
   over time.
4. **Gate.** It protects you from arbitrary code running on your system by gating potentially dangerous fs, net and
   env access, in the day of AI and data exfiltration.

The logic is lib's `util/silo` (pure where it can be, so the editor runs it in the browser). This package is the
command line. The editor is the other front end.

## How it got here

Silo began as a desktop-first command line (the prototype, since abandoned), and was first about approving or waiving
AI-written code: how likely a file was written by AI, which code units were reviewed. Most code is AI-written now, so
that part wasn't worth pursuing. Then the editor became the better place for silo to exist and be productized. Parts of
the prototype that haven't been urgent there stayed behind, because the editor runs in the browser, which is already a
sandbox: gating a program run from a terminal matters on a desktop, much less in a browser tab.

The goal is to reconcile the two: each job implemented once, in lib `util/silo`, with the command line and the editor
as two front ends to it. Where a job seems to be missing something, the prototype is the first place to look.

This document is an inventory of what exists, written 2026-10-14 after `silo` grew seven subcommands in two days
without a plan. It describes, it doesn't decide: the open questions at the end are decisions still to make.

## The model

- **Baseline: static facts.** When a library is added, its code is analyzed and what it can do is recorded. The
  baseline changes when dependencies change, never because of runs.
- **Policy: your stance.** Your default, or your org's (the shared contract, then yours), for the trust-on-first-use
  prompt: whether a call outside what the baseline says is allowed, denied or asked about.
- **Exceptions: in the run.** When a call's outcome differs from the policy's default, the run records it in its
  `runs/<user>.jsonl` envelope. "Always allow" also updates your policy, and it stays in the run record in case you
  never commit your policy file.
- **At the call.** A package's call outside its baseline asks, the same as the program's own calls.

## The four jobs, and what exists for each

| Job | Question it answers | Command line | Editor | lib `util/silo` | In `.silo/` |
|---|---|---|---|---|---|
| Anticipate | What could this package do? | `init`, `install` (record the baseline) | `workbench/baseline.ts` | `detect`, `audit`; `packages`, `deobfuscate` (unused, see below) | `baseline.json` |
| Track | Has a package started doing something new? | `install` (sync, nothing under a week old), `accept` (approve a pending version), `check` (runs beyond the baseline) | — | `audit`, `evidence` (`beyondBaseline`, `acceptPending`) | `baseline.json`, `runs/` |
| Remember | What does my program do, what ran, how has it grown? | `coverage` (what committed runs ran, by feature), `features`, `history` | insights (coverage in the gutter), notes, the history extension | `evidence`, `runs`, `coverage`, `features`, `graph`, `history`, `exercise`, `oxc`, `ts-analysis`, `typescript`, `git-snapshots`, `annotations`, `layout` | `runs/`, `evidence/`, `policy*` |
| Gate | Should this call happen? | none | the capabilities extension (static squiggles, the tsval canary), the bridge's `decide` (the prompt), the debugger's capability stops | `policy`, `enforce`, `reach`; util/mcp's broker for MCP tools | `policy.json`, `policy/<user>.json`, `local/registry.json` |

## What the prototype had, and where it is now

The prototype is `~/Documents/GitHub/silo` (its README is the design doc). Its pieces:

| Prototype | What it did | Now |
|---|---|---|
| `silo <script>` (runner) | Drift check, then bundle the script with a capability broker injected and run it, prompting on any new scope; grants persisted, runs recorded, confidence updated | **No desktop runner.** The decision core is lib `util/silo/enforce/decide.mjs` (used by util/mcp's broker); the editor gates its own runs |
| BERNARD / JUDICIAL | A redline nothing can auto-approve (secrets, `rm`, `eval`, system dirs, unknown hosts), then a pluggable decider (a command, an agent, you) | `enforce/decide.mjs` (`redline`, `judicial`) |
| `silo audit` | Per dependency: the members your code imports, joined with what that slice can reach (tree-shaken, deobfuscated with webcrack ∪ wakaru), diffed against `.silo/baseline.json`; exits 1 on drift | Split: `audit` (the import surface and builtins) is live; the package half (`packages`, `deobfuscate`) is **cut off** (see question 1) |
| `silo install` (cooldown) | Nothing published in the last week; a breadcrumb for the runner when the lockfile moves | `silo install` (live) |
| CI gate | The audit in CI, as a GitHub Action (`action.yml`) | Not carried over |
| Two static engines | TypeScript's call hierarchy (precise, under-reports) and tree-shaking (over-reports); their disagreement is the blind-spot detector | `detect`/`reach` (pattern-based); the TypeScript reading is in `ts-analysis` for history, not capabilities |
| Confidence | Runs raise it, edits decay it (Wilson lower bound) | `runs.ts` `confidence` |
| Deno backend | Permissions as a stronger box than the in-process broker | Not carried over |
| `review`, `--reviewed`, `--waive`, `accept <ref>`, provenance | Per-function "have you read it", the AI-approval axis | Dropped on purpose (most code is AI-written); `provenance`, `review` remain in lib |
| Fail-loud (`design/fail-loud.md`, designed) | Value invariants: AI code hedges (`?.`, `??`) on values your code guarantees, turning a crash into a silent wrong answer; guard at trust boundaries (the capability seams), let internal invariants fail loudly; invariants learned from recorded runs, human-gated; `waive(value, reason)` as a codified exception | Built in the editor under Remember: runtime evidence (value and branch observations per span, RUNTIME-EVIDENCE.md's second slice) and insights' "what could go" suggestions (its fourth). Its static half leaned on `strictNullChecks`; TypeScript here is relaxed by choice, so runs are the route |

Note the name collisions: the prototype's `accept <ref>` meant "trust everything as of this commit"; today's
`silo accept` means "approve a package's pending version". And three things have been called a waiver or an
exception: the prototype's `--waive` (accepted unread), fail-loud's `waive(value, reason)` (suppress one assert), and
today's exceptions (a capability call whose outcome differed from the policy, recorded in the run).

## Modules nobody uses

These are in lib `util/silo`, but nothing in the editor, the command line or the rest of lib imports them:

- **`packages`**: a package's capabilities, from bundling the slice of it you import. It's the only thing that uses
  `deobfuscate`, so that's unused too in effect. Not leftovers: they're the prototype's package analysis, the core of
  Anticipate, cut off when `audit` was ported.
- **`guard`**: a runtime check at a boundary, with a pluggable reaction.
- **`provenance`**: how likely a file was written by AI. The prototype's original purpose (approving AI-written code),
  dropped on purpose: most code is AI-written now. `review` (which code units were reviewed, `review.json`) belongs
  with it; only `audit` still reads it.

All three came over from the `silo` prototype.

## What doesn't fit (open questions)

1. **The baseline analyzes packages more coarsely than the prototype did.** Both front ends run lib's `detect` (a
   pattern scan) over every code file of each package's own tarball: the editor from the registry, the command line
   from node_modules. The prototype was finer: only the slice of a package your code imports (tree-shaken), and
   deobfuscated first (`package-capabilities`, `deobfuscate`), which the port into lib cut off.
2. **There's no gate outside the editor.** The editor gates its runs (tsval, almostnode) and util/mcp gates MCP tools,
   but nothing gates a program you run from a terminal. The prototype's `silo <script>` was that gate (a bundled
   broker, BERNARD and JUDICIAL); its decision core survived, its runner didn't. A `silo run` has been discussed
   (tsval with policy, recording exceptions) and not built. Not urgent while the editor (already a browser sandbox) is the product, but needed to
   reconcile the two.
3. **Two stores of what code can do.** `baseline.json` holds what packages can do (Anticipate). `capabilities.json` and
   `capabilities/<user>.json` hold what the code can do and what it was seen doing (the capabilities extension's). How
   they relate isn't written down.
4. **Two attributions of runs to features.** `coverage` (the command line) and `exercise` (the history extension) both
   say which features ran. Both rest on the feature list, which is specific to this repo (CHANGE-HISTORY.md, "Ways in
   beyond this repo").
5. **Which subcommands belong.** By the four jobs, all seven do: three for Track, two for Anticipate (with overlap),
   three for Remember, none for Gate. But they aren't grouped that way, the file's own header lists five of them, and
   `features` and `history` rest on the parked feature layer.
6. **The leftovers.** Whether `packages` and `deobfuscate` get wired into the baseline (see 1), and whether `guard`
   stays. `provenance` and `review` serve the dropped AI-approval purpose: whether to remove them.

## Plan: one silo, two front ends

Each job is implemented once in lib `util/silo`; the command line and the editor only present it. The prototype's
AI-approval (approve, waive, review, provenance) isn't coming back. Nor is a separate approval step for packages:
everything a person decides lives in their policy.

### Principles

- **Facts in the baseline, decisions in the policy, outcomes in the runs.** The baseline only records what code can do.
  The policy says what's allowed (the shared contract, then yours). A run records what happened, including each
  exception to the policy. Nothing else holds a decision.
- **Git is the review.** A change to `baseline.json` or a policy file is reviewed the way code is: in the commit that
  makes it. No command exists only to approve.
- **The same answer from both front ends.** Same analysis, same files, same decision core (`enforce/decide.mjs`), same
  run record. Where a front end can't do something (no node_modules in the browser, no terminal prompt in the editor),
  it reads what the other one wrote instead of computing something different.
- **No subcommand without a job.** Every subcommand is one of the four jobs, and says which.

### No `accept`: what replaces "pending"

Today a newer version that can do more is "pending" in the baseline until a person runs `silo accept` (or clicks Accept
in the editor's Exceptions view); meanwhile its new capabilities ask at the call. That's a decision stored in the facts.
Instead:

1. **The baseline records what grew.** When a package's new version can do more, the baseline takes the new facts at
   once, and notes each capability's origin: the version that introduced it. "`foo` 2.3.1 added `net`" is a fact.
2. **Policy decides what a grown capability does at the call.** By default it asks, as any call outside the baseline
   does. "Always allow" writes your policy (`policy/<user>.json`), which is the approval, reviewed in its commit. A
   project can set the default to deny in its shared contract (for CI, say).
3. **Track reports growth instead of blocking on it.** `silo install` prints what each upgrade added. `silo check` exits
   1 when a package gained a capability no policy rule covers, so CI can require a policy decision.

This removes `silo accept`, the editor's Accept action, and lib's `pending`/`acceptPending`. They're replaced by a
capability's origin in the baseline and by policy rules.

### The jobs, reconciled

| Job | Command line | Editor | Shared in lib |
|---|---|---|---|
| Anticipate | `silo install` makes and syncs the baseline (no separate `init`: the first install starts `.silo/`, as the prototype onboarded on first run) | Syncs the baseline from the registry as dependencies change (today's `workbench/baseline.ts`) | One package analysis, given a package's files however they were read (node_modules or a tarball) |
| Track | `silo install` (nothing under a week old; reports growth); `silo check` (runs and growth beyond policy; CI gate, with the prototype's GitHub Action back) | The resolver takes nothing under a week old; the Exceptions view shows growth and exceptions, the same list `silo check` prints | The resolver's age rule, `beyondBaseline`, growth |
| Remember | `silo coverage` (what committed runs ran); `features`/`history` stay, parked (CHANGE-HISTORY.md) | Insights (coverage, values, "what could go"), notes; the history extension for the session | One run record (`runs/<user>.jsonl`), one evidence format, one attribution of runs to features |
| Gate | `silo run <file>` (new): runs a program with every gated call decided by the policy, and records the run as the editor does | Runs in the debugger, almostnode, previews, gated as today | `enforce/decide.mjs` (BERNARD, JUDICIAL), policy, the run envelope |

So the command line becomes: `install`, `check`, `run`, `coverage`, with `features` and `history` parked. `init` folds
into `install`; `accept` goes.

### In order

1. **Take out what isn't coming back.** lib's `provenance` and `review` (with `review.json` and `audit`'s use of it), and
   `pending`/`acceptPending`, replaced by each capability's origin and the policy default for grown capabilities (lib
   first, then both front ends in one change, since they read the same `baseline.json`).
2. **One package analysis.** Both front ends call the same lib function on a package's files. Then decide whether
   deobfuscation joins it (see decisions).
3. **`silo check` as the CI gate**, with the prototype's GitHub Action brought back.
4. **`silo run`**, the desktop gate: the policy and decision core the editor already uses, a terminal prompt in place of
   the editor's, and the same run envelope.
5. **One run record and one attribution.** Fold the local MCP ledger and the shared runs into one shape, and have
   `silo coverage` and the history extension share one way of saying which features ran.

### Decisions to make

- **Grown capabilities' default:** ask (as proposed), or deny in CI and ask locally.
- **Deobfuscation in the baseline:** webcrack and wakaru are JavaScript and could run in the browser, but they're heavy.
  Either both front ends deobfuscate (one analysis), or neither does yet. Not one each: two analyses would write
  different baselines, and the file would flip with whoever synced it last.
- **The slice you import (tree-shaking):** finer, but it needs the consumer surface, which only the command line has
  today. Defer, or bring it to both.
- **What `silo run` runs on:** tsval (the editor's interpreter: identical gating and evidence, but slower and not every
  program), the prototype's bundled broker (any program, gating only at what it intercepts), or Node's permission model
  (coarse, and no prompt).
- **`guard`:** keep it as the seed of fail-loud's `invariant()`, or remove it with the other leftovers.

