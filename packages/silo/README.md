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
| Track | Has a package started doing something new? | `install` (sync, nothing under a week old; reports what each upgrade grew), `check` (runs beyond the baseline) | the Exceptions view (what grew) | `audit`, `evidence` (`syncPackages`, `settledCaps`, `beyondBaseline`) | `baseline.json`, `runs/` |
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

Note the name collisions: the prototype's `accept <ref>` meant "trust everything as of this commit"; a later
`silo accept` (removed) meant "approve a package's pending version". And three things have been called a waiver or an
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

## Design: one silo, two front ends

A design, not a build plan: what silo should be once the command line and the editor are reconciled. Nothing here is
scheduled. Each job is implemented once in lib `util/silo`; the command line and the editor only present it. The prototype's
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
- **The run is the gate, everywhere.** There's no separate check: a program run through silo is gated at each call, and
  where nobody can be asked (CI), a call that's needed but neither in the baseline nor allowed by policy fails the run.

### No `accept`: what replaced "pending"

A newer version that could do more used to be "pending" in the baseline until a person ran `silo accept` (or clicked
Accept in the editor's Exceptions view); meanwhile its new capabilities asked at the call. That was a decision stored in
the facts. Now (built):

1. **The baseline records what grew.** When a package's new version can do more, the baseline takes the new facts at
   once, and notes each capability's origin in the entry's `grew`: `{"net": "2.3.1"}` — "`foo` 2.3.1 added `net`" is a
   fact. What it could do when it was added is `settledCaps`; a grown capability is outside the baseline at the call.
2. **Policy decides what a grown capability does at the call.** By default it asks, as any call outside the baseline
   does. "Always allow" writes your policy (`policy/<user>.json`), which is the approval, reviewed in its commit. A
   project can set the default to deny in its shared contract (for CI, say).
3. **Track reports growth; the run enforces.** `silo install` prints what each upgrade added. Nothing blocks at install:
   the decision comes at the call, when the capability is actually used. In CI, where nothing can ask, `silo run` fails
   on it, so a pull request that needs a new capability needs a policy rule (reviewed in that pull request) to pass.

This removed `silo accept`, the editor's Accept action, and lib's `pending`/`acceptPending`. `silo check`, whose job the
run does, goes when `silo run` exists. They're replaced by a capability's origin in the baseline, policy rules, and the
run's own failure in CI.

### Each dependency, seen four ways

Anticipate and Track watch a dependency from both sides, and its usage. Each view is narrower than the one before it:

| View | Question | Changed by | Today |
|---|---|---|---|
| **The package** | What can its own code do? | A new version | `baseline.packages[name].caps`: lib `detect` over every code file of the package. Live in both front ends; what `grew` is recorded on |
| **Your usage** | Which of its exports does your code import and call? | Your code | `baseline.consumer[workspace][spec].members`: lib `audit`'s import surface (oxc, member-level; computed access is `*`). Command line only; the editor never writes `consumer` |
| **The join** | What can the part you use reach, tree-shaken? | Either side | lib `packages` (rolldown tree-shaking from the members you import, deobfuscated first). Built, never called |
| **Runs** | What did it actually do? | Running it | Each run's effects, by package (`runs/<user>.jsonl`); the editor's debugger gates and counts them |

As everywhere in this project, the heuristic is the floor and what runs derive is the ceiling: the analysis answers
before anything has run, and the runs say what's true. In sets the order reads the other way: the package should
contain the join, which should contain what ran. "Should", because `detect` is a pattern scan and can miss things. The
signals are in the gaps:

- **The join grew from the package's side.** A new version reaches more through the members you already use: the
  supply-chain signal.
- **The join grew from your side.** Your code started using a member that reaches more (`fetchAll`, and with it `net`).
  The prototype counted this as drift too: "is my relationship to this package still the one I approved?"
- **A call the join didn't predict.** A blind spot in the analysis, or a package hiding what it does. It never just
  happens: the gate stops it before it's made and asks (allow, allow always, deny), and the answer is recorded in the
  run as an exception to the policy.
- **The join allows what no run used.** A candidate for a narrower policy (least privilege).

What this asks of the design:

1. **The baseline holds the join, not just the package.** The gate decides a package's call against what the part you
   use can reach, which is tighter than what the whole package can.
2. **A grown capability's origin is a version or your code.** `grew` today records only a version (the package's
   side); growth from your side needs the member(s) that brought it in.
3. **The editor computes your usage.** It's half the join, and only the command line has it now. In the editor it can
   come from the TypeScript server it already runs (the import surface is a reading of your code, which is analysis's
   job: TypeScript 7, not BABLR).
4. **Nothing outside the join runs unasked.** Wherever a package's call can't be decided (no baseline yet, nobody to
   ask), it's refused, as a preview's are, not just counted.

### The jobs, reconciled

| Job | Command line | Editor | Shared in lib |
|---|---|---|---|
| Anticipate | `silo install` makes and syncs the baseline (no separate `init`: the first install starts `.silo/`, as the prototype onboarded on first run) | Syncs the baseline from the registry as dependencies change (today's `workbench/baseline.ts`) | One package analysis, given a package's files however they were read (node_modules or a tarball): the slice of each package the code imports (the import surface, tree-shaken), as the prototype's audit did |
| Track | `silo install` (nothing under a week old; reports what each upgrade added) | The resolver takes nothing under a week old; the Exceptions view shows growth and the runs' exceptions | The resolver's age rule, growth, `beyondBaseline` |
| Remember | `silo coverage` (what committed runs ran); `features`/`history` stay, parked (CHANGE-HISTORY.md) | Insights (coverage, values, "what could go"), notes; the history extension for the session | One run record (`runs/<user>.jsonl`), one evidence format, one attribution of runs to features |
| Gate | `silo run <file>` (new): Node with silo's `--import` preload (below), every gated call decided by the policy, the run recorded as the editor does; asks at a terminal, fails where it can't ask (CI) | Runs in the debugger, almostnode, previews, gated as today | `enforce/decide.mjs` (BERNARD, JUDICIAL), policy, the run envelope |

So the command line becomes: `install`, `run`, `coverage`, with `features` and `history` parked. `init` folds into
`install`; `accept` and `check` go. In CI, the gate is running the project (its tests, its scripts) through `silo run`.

### What the design implies, when it's built

- **Out:** lib's `provenance` and `review` (with `review.json` and `audit`'s use of it); `silo init` and `check`.
- **One package analysis**, called by both front ends on a package's files, however they were read.
- **`silo run`**, the desktop gate: the policy and decision core the editor already uses, a terminal prompt in place of
  the editor's, failure in place of a prompt in CI, and the same run envelope.
- **One run record and one attribution**: the local MCP ledger and the shared runs in one shape, and one way, shared
  by `silo coverage` and the history extension, of saying which features ran.

### The desktop gate: a `--import` preload

`silo run <file>` is Node with silo's preload: `node --import <silo>/preload <file>`, or ambient,
`NODE_OPTIONS="--import <silo>/preload"`, so any Node process (tests, npm scripts, tools) is gated. The prototype built
it (`enforce/preload.mjs`): it overrides `fetch` for net, and uses Node's `module.registerHooks` (22.15+) to swap in
wrapped `node:fs` and `node:child_process` as they load. That runs the real files, without bundling, and catches the
dynamic `import()` and `createRequire` a bundle misses. Two of its parts are in lib already: `enforce/intercept.mjs`
(which builtin method is which capability; it names the preload as one of its bindings) and `enforce/broker.mjs` (the
gate's order: the redline, the grants, the decider, with the prompt left pluggable). The preload binding itself, with
a terminal prompt or failure in CI, is what's missing.

### Decided

- **Analysis: wanted, in both front ends.** Both sides of each dependency and their join, checked against the runs, as
  in "Each dependency, seen four ways". The editor needs your usage (the import surface) for it, which only the command
  line computes today.
- **Deobfuscation: later.** It joins the one analysis, in both front ends, when it comes.
- **The desktop gate is the `--import` preload**, above.
- **`guard` is not gating.** It's a runtime type check at a boundary (a value against its declared type), reacting
  through a pluggable handler (record and keep going, throw, or hand to a broker): the runtime target for
  type-generated asserts, fail-loud's type-derived half. It belongs with fail-loud, under Remember, not with the gate.
  It stays in lib as the runtime piece; the editor builds out the asserts that call it (inserted by tsval's and the
  preview dev server's transforms, shown with the runtime evidence). No subcommand: nothing about it is typed. Later,
  the desktop preload could insert the same asserts as files load (its load hook can transform source), without a new
  command.

### Decisions to make

- **The shape of a grown capability's origin.** A version (`{"net": {"version": "1.1.0"}}`) or the members that
  brought it in (`{"net": {"members": ["fetchAll"]}}`); and whether growth from your side is recorded in the baseline at
  all, or only seen in your code's diff (the baseline's `consumer` already changes in that commit).

(The questions above, "What doesn't fit", are otherwise answered by this design.)

