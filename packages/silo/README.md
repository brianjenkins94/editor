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
  baseline is made when silo starts keeping `.silo/` (`silo init`; in the editor, as a project opens), recomputed after
  each install (in the editor, as the dependencies change), and spot-checked at each call: an entry of another version
  than the one running says nothing of it. It changes when dependencies change, never because of runs.
- **Optional.** A project can go without one. Then the policy decides every package call, and what's lost is tracking:
  how the dependencies change over time, and how the project's use of them does. A missing baseline should be rare,
  and isn't an error.
- **Policy: your stance.** Your default, or your org's (the shared contract, then yours), for the trust-on-first-use
  prompt: whether a call outside what the baseline says is allowed, denied or asked about.
- **Exceptions: in the run.** When a call's outcome differs from the policy's default, the run records it in its
  `runs/<user>.jsonl` envelope. "Always allow" also updates your policy, and it stays in the run record in case you
  never commit your policy file.
- **At the call.** A package's call outside its baseline (or with no baseline) is the policy's to decide, the same as
  the program's own calls: allowed, denied, or asked; and recorded in the run, however it was decided.

## The four jobs, and what exists for each

| Job | Question it answers | Command line | Editor | lib `util/silo` | In `.silo/` |
|---|---|---|---|---|---|
| Anticipate | What could this package do? | `init`, `install` (record the baseline) | the capabilities extension's `baseline.ts`, reading packages in its worker | `detect`, `audit`; `packages`, `deobfuscate` (unused, see below) | `baseline.json` |
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
| `review`, `--reviewed`, `--waive`, `accept <ref>`, provenance | Per-function "have you read it", the AI-approval axis | Dropped on purpose (most code is AI-written); lib's `provenance` and `review` were removed (2026-10-14) in lib |
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

Both came over from the `silo` prototype. (`provenance` and `review`, the AI-approval purpose's, were removed.)

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
   stays. (`provenance` and `review`, the dropped AI-approval purpose's, are removed.)

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
| **Your usage** | Which of its exports does your code import and call? | Your code | `baseline.consumer[workspace][spec].members`, by lib `consumerOf` in both front ends: both from each file's import surface (`surfaceOf`): the editor off its TypeScript server's tree, the command line with the TypeScript 7.1 it bundles |
| **The join** | What can the part you use reach, tree-shaken? | Either side | `baseline.consumer[workspace][spec].caps`: lib `sliceCaps` (rolldown tree-shakes the package's files from the members you import; `detect` reads what's left). The editor's off each tarball, in the package worker with `@rolldown/browser`; the command line's off node_modules with rolldown (`ensureBaseline`). Which uses to slice, and which joins to keep, is lib's (`joinsWanted`), so either front end leaves the other's file as it is |
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

1. **The baseline holds the join, not just the package** (built in both front ends). Each `consumer` entry keeps its
   slice's `caps`, and the gate decides a package's call against them (lib `settledReach`: the joins of every spec
   your code imports of it, else the whole package's caps for one it doesn't import itself, and only while the
   baseline's version is the one installed). A slice that can't be built keeps the whole package: the safe side.
2. **A grown capability's origin is a version or your code** (built). The package's `grew` records the version; a
   `consumer` entry's `grew` records the members that brought it in, else the version (`{"net": "fetchAll"}`,
   `{"net": "1.1.0"}`; lib `syncConsumer`), and drops a capability once it's no longer reached. Either way it
   asks until the policy allows it. Nothing grows when the baseline is first made, or for a package just added (trust on
   first use).
3. **The editor computes your usage** (built). It's half the join. The editor reads it off the TypeScript server it
   already runs (the capabilities plugin's `_capabilities.surface`), as code changes, into `consumer`.
4. **Nothing outside the join runs undecided.** A package's call the baseline doesn't cover (none kept, or an entry of
   another version) goes to the policy, and the run records how it went. Where nobody can be asked (a live run, CI), the
   policy decides alone, and what it would ask about is refused.

### The jobs, reconciled

| Job | Command line | Editor | Shared in lib |
|---|---|---|---|
| Anticipate | `silo install` makes and syncs the baseline (no separate `init`: the first install starts `.silo/`, as the prototype onboarded on first run) | Makes the baseline from the registry as a project opens, and syncs it as dependencies change (the capabilities extension, in a worker of its own; the `silo.baseline` setting turns it off) | One package analysis, given a package's files however they were read (node_modules or a tarball): the slice of each package the code imports (the import surface, tree-shaken), as the prototype's audit did |
| Track | `silo install` (nothing under a week old; reports what each upgrade added, and what your use of a package reaches more) | The resolver takes nothing under a week old; the Exceptions view shows growth and the runs' exceptions | The resolver's age rule, growth, `beyondBaseline` |
| Remember | `silo coverage` (what committed runs ran); `features`/`history` stay, parked (CHANGE-HISTORY.md) | Insights (coverage, values, "what could go"), notes; the history extension for the session | One run record (`runs/<user>.jsonl`), one evidence format, one attribution of runs to features |
| Gate | `silo run <file>` (new): Node with silo's `--import` preload (below), every gated call decided by the policy, the run recorded as the editor does; asks at a terminal, fails where it can't ask (CI) | Runs in the debugger, almostnode, previews, gated as today | `enforce/decide.mjs` (BERNARD, JUDICIAL), policy, the run envelope |

So the command line becomes: `install`, `run`, `coverage`, with `features` and `history` parked. `init` folds into
`install`; `accept` and `check` go. In CI, the gate is running the project (its tests, its scripts) through `silo run`.

### What the design implies, when it's built

- **Out:** `silo init` and `check`. (lib's `provenance` and `review` are out already, as is oxc: TypeScript reads the
  code everywhere — the editor's TypeScript server, and the TypeScript 7.1 `silo` bundles.)
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

### Where analysis lives when TypeScript 7 arrives

The editor reads code inside tsserver today, through plugins: capabilities (its squiggles, `_capabilities.surface`,
`_types.at`, `_statements`, the canary), history (`_history.read`), and eslint (its engine runs there, borrowing
tsserver's Program, and `_eslint.fixAll` is a tsserver request). TypeScript 7's native language server is Go, speaks
LSP, and loads no JavaScript plugins, so when the editor's TypeScript (pinned through `monaco-vscode-api`; 6.0.3 today)
moves to 7, all of them lose their host — whatever parser they use. We choose when that happens.

What each needs isn't a plugin: a tree of the current text (unsaved edits included), and for some a checker.

| Today in the plugin | Needs |
|---|---|
| capabilities' squiggles, `_capabilities.surface` | the tree |
| `_types.at`, `_statements` | the tree and the checker |
| history's `_history.read` | the tree and the checker's symbols |
| the canary | a `ts` to run tsval with |
| eslint (typescript-eslint) | a classic TypeScript Program (≤ 6) |

eslint will stay on TypeScript 6 long after VS Code is on 7: every lint plugin with type-aware rules is written against
the classic API through typescript-eslint, which doesn't support 7 (TypeScript's own advice is to run 6 beside 7 for
it). So eslint needs a TypeScript 6 of its own, not a borrowed one.

The plan, none of it scheduled:

1. **The readings in lib, behind one seam** (built 2026-10-14). `findReach`, `surfaceOf` and `ts-analysis` take `ts`
   (or a `TsHost`) and run on 6.x and 7.1 alike (`astOf` adapts 7.1's AST module); `_types.at` and `_statements`, once
   written in `ts-plugin.js`, are lib's `typed` (`typesAt`, `typeAtStart`, `statementsOf`). A plugin is a thin adapter,
   and a TypeScript 7 adapter is the other one (`typescript.ts` already is, for history).
2. **Findings published by the extension, not injected into tsserver's diagnostics** (built 2026-10-14). The plugin
   answers `_capabilities.findings`, and the capabilities extension shows them through its own diagnostic collection
   (`findings.ts`; or, later, as LSP middleware), so the plugin only answers requests — the shape the TypeScript 7
   host has.
3. **eslint in a realm of its own, with its own TypeScript 6** (a worker, as the cspell server is): its own language
   service and Program over the workspace, its fix-all its own. It's the plugin with a known destination and the
   hardest to move later. Measured 2026-10-14 (below): moving it as it is costs about 20 MB; giving it types costs a
   Program, from about 90 MB to 550 MB by project, or about 135 MB on a large one if the Program is rooted at the open
   file.

4. **A TypeScript 7 host for capabilities and history.** What replaces `typescriptServerPlugins` and
   `typescript.tsserverRequest` when VS Code adopts 7.1, per Jake Bailey (TypeScript team, 2026-10-14): "you can ask our
   extension for an api connection, and we support lsp middleware proxying". So an extension asks VS Code's TypeScript
   extension for a 7.1 API connection to the server it already runs — the program, checker and current text a plugin
   reads today, through the same API `silo` uses (`./typescript`'s host) — and anything a plugin added to the server's
   answers (diagnostics, hovers) it adds as LSP middleware instead. 7.1's API attaching to a running server
   (`API.fromLSPConnection`, `custom/initializeAPISession`, as the unreleased Playground v2 does) is that connection.
   In the browser this needs the server itself to run there (a `tsc.wasm`, not published yet); on the desktop it's
   there.

1 and 2 are mechanical and make the switch one adapter, over a connection we know we'll get; 3 is measured (below):
cheap to move as it is, a Program's worth to move with types; 4 waits on VS Code shipping 7.1 (and, for the browser
editor, TypeScript 7 in the browser).

#### What a second TypeScript Program costs (measured 2026-10-14)

eslint in the editor doesn't lint with types today, and in fact runs none of typescript-eslint's rules. Its plugin
doesn't load in the browser: through `@typescript-eslint/utils` it imports ESLint's Node API, which reads
`process.hrtime.bigint` as it loads, and the browser's `process` has no `hrtime` (`_eslint.status` says so). The engine
drops the rules of a plugin that didn't load, so the preset's `ts/*` rules — the 13 type-aware ones among them
(`no-floating-promises`, `no-misused-promises`, `naming-convention`, `no-deprecated`, `unbound-method`, …) — report
nothing; nor do `style`, `node`, `test`, `jsdoc` or `eslint-comments`, each failing on a Node gap of its own. Checked in
the editor: a floating promise isn't reported, a `var` beside it is. The desktop's eslint reports both. The tsserver
plugin now hands the engine the server's Program (below), for when the plugin loads.

So the question is what a Program of its own costs, in a worker: TypeScript 5.9 (the editor's built chunk), a Program
over each project's tsconfig, as tsserver opens it, then every file checked, as linting the whole project would. Memory
is the worker's, from `measureUserAgentSpecificMemory` (eager, as the performance suite reads it); the same Program in
Node, file for file, for comparison.

| Project | Files (own) | TypeScript loaded | Program built | Open file checked | Every file checked | Node, every file |
|---|---|---|---|---|---|---|
| the demo | 218 (3) | 20 MB | 69 MB | 86 MB | 86 MB | 125 MB |
| games | 679 (167) | 20 MB | 165 MB | 201 MB | 230 MB | 362 MB |
| lib | 1,473 (112) | 20 MB | 164 MB | 207 MB | 293 MB | 520 MB |
| this editor | 4,361 (1,127) | 20 MB | 362 MB | 451 MB | 552 MB | 1,010 MB |
| this editor, rooted at the open file | 216 | 20 MB | 112 MB | 134 MB | — | — |

For scale: on the demo, CI's performance run has tsserver's semantic server at 180 MB (eslint's engine and the
capabilities plugin included), the syntax server at 109 MB, and the tab at 754 MB; the budgets are 1,000 MB for the
semantic server and 2,200 MB for the tab. A browser Program costs a little over half what Node's does (Chrome compresses
pointers).

What follows from it:

- **Moving eslint as it is costs about 20 MB**: a TypeScript in another realm. The engine and its plugins move out of
  the semantic server, so they aren't added.
- **Type-aware lint, while eslint still runs inside tsserver, costs nothing**: the plugin hands typescript-eslint the
  server's own Program (`parserOptions.programs`, from `getProgram()`; built 2026-10-14, the lint pass only — a fix-all
  pass changes the text the Program holds). It takes effect once typescript-eslint's plugin loads in the browser, which
  needs `process.hrtime` first (lib's `polyfillNode`), and perhaps more after it.
- **Type-aware lint in a realm of its own costs a Program**, beside the TypeScript server's own: about 90 MB on the demo
  and 200 MB on a mid-sized repository, up to 450–550 MB on one this editor's size. Rooted at the open file instead of
  the whole tsconfig, about 135 MB even there, rebuilt as the open file changes. When VS Code moves to TypeScript 7 the
  classic Program in tsserver goes away, so this one is what's left of it rather than a second one.

**Running it under almostnode instead (spike, 2026-10-14).** The bundled engine imitates Node with lib's
`polyfillNode`, and each plugin finds another gap; almostnode is the editor's Node already (dev servers, debug runs,
cspell). Real ESLint with the preset, run under almostnode (in Node, as almostnode's tests run it), on a file with a
floating promise: the same 9 messages Node's ESLint gives, `ts/no-floating-promises` among them (typescript-eslint's
project service, with types, inside almostnode), in 458 ms (Node: 468 ms), 4.5 s the first time with loading.
Getting there fixed almostnode, not the plugins — top-level `await`, live ES module bindings (its ESM→CommonJS
transform is TypeScript's own now), `require()` of a folder, `main` before `module`, and a handful of missing
built-ins (almostnode's README lists them). Next: the same in a browser worker, its packages installed as the debug
worker installs them (the run read 252 packages, 68 MB unpacked), then the eslint extension talking to it as cspell's
does.

### Decided

- **Analysis: wanted, in both front ends.** Both sides of each dependency and their join, checked against the runs, as
  in "Each dependency, seen four ways". Both front ends now record your usage (the import surface); the join is
  what's left.
- **TypeScript reads the code, everywhere; no oxc.** The editor reads it off its TypeScript server's tree; `silo`
  bundles TypeScript 7.1 (a nightly, pinned, until 7.1 is released) and reads every project with it, whatever the
  project has (no tsconfig: TypeScript's defaults). lib's readings take `ts` as a parameter, so the same code runs on
  6.x and 7.1 (`astOf` adapts 7.1's AST module).
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

(The questions above, "What doesn't fit", are otherwise answered by this design.)

