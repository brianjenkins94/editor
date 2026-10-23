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
| Remember | What does my program do, what ran, how has it grown? | `coverage` (what committed runs ran, by feature), `features`, `history` | insights (coverage in the gutter), notes, the history extension, the Margin's kept runs (its balls) | `evidence`, `runs`, `coverage`, `features`, `graph`, `history`, `exercise`, `oxc`, `ts-analysis`, `typescript`, `git-snapshots`, `annotations`, `traces`, `layout` | `runs/`, `evidence/`, `traces/`, `policy*` |
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
   say which features ran. Both rest on the feature list, which is specific to this repo (*Derived history*, below: why it's parked).
5. **Which subcommands belong.** By the four jobs, all seven do: three for Track, two for Anticipate (with overlap),
   three for Remember, none for Gate. But they aren't grouped that way, the file's own header lists five of them, and
   `features` and `history` rest on the parked feature layer.
6. **The leftovers.** Whether `packages` and `deobfuscate` get wired into the baseline (see 1), and whether `guard`
   stays. (`provenance` and `review`, the dropped AI-approval purpose's, are removed.)
7. **Tests and purity have no job yet.** Which tests reach which code, and which functions are pure (both designed
   below, neither built), are facts about your own code, not about packages or calls. Keeping what runs observed is
   Remember; choosing which tests to run, and deciding purity statically, fit none of the four as they're written.

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
| Remember | `silo coverage` (what committed runs ran); `features`/`history` stay, parked (*Derived history*, below) | Insights (coverage, values, "what could go"), notes; the history extension for the session | One run record (`runs/<user>.jsonl`), one evidence format, one attribution of runs to features |
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
   hardest to move later. Built 2026-10-14, under almostnode (below). Measured 2026-10-14 (below): moving it as it is costs about 20 MB; giving it types costs a
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
built-ins (almostnode's README lists them).

**Built (2026-10-14).** The eslint extension's worker (`extensions/eslint/worker.ts`) runs it in the browser: the build
traces a real lint and packs the 252 packages it loads (`lsp/eslint-toolchain.tgz`, 9.8 MB — each package whole, less
maps, type declarations and docs; TypeScript kept to its compiler API and lib files), the worker unpacks them under
almostnode (resolving as Node does, `browserField: false`) and reads the workspace through the workspace runtime, as
tooling reads — never asked about. The extension shows its problems as its own diagnostics (so eslint's `info` is
Information now, not a Warning) and fixes through it. In the editor: ESLint loads in about 4 s, and a floating promise is
reported, with types. The engine bundled into tsserver, its plugin and the preset's build-time extraction are gone. A repository's own
`eslint.config.*` is what it lints with (the preset when there's none, or when it fails to load — said as a problem on
the config): its code runs in the worker, whose network is shut once the toolchain is fetched, over a read-only
workspace; its imports resolve to the toolchain for the packages it carries, the workspace's node_modules for the rest.

### Which tests reach what (designed 2026-10-22; the record built 2026-10-23)

Two uses for one record. **Selection:** run the tests a change could break, not all of them. **Features:** a test is a
way in every repository already has, and its file and title name what it's for. That's what the feature layer lacked:
its ways in are a list written for this repository (*Derived history*, below: why it's parked).

A spike (2026-10-22, scripts not kept) measured both. Coverage came from our own instrumentation, never V8's, because
it has to run in the browser. Each module went through almostnode's `frameworks/instrument.ts`, the transformer the
preview dev server uses, and was counted per test:
- **Unit tests:** in a Node load hook standing in for almostnode's compile.
- **Architecture suites:** in an editor built with every pass instrumented, with `previews/page-evidence.ts`'s runtime
  in each realm (the shell, the workbench, the extension host, the LSP workers, the service worker), read by the
  harness around each test.

What it found:
- **Clusters.** Grouping the editor's 140 unit tests by the declarations they reach (581, a top-level name or
  `Class.member`), with no test names as input, mostly gives features. Some span several test files (the event sheet's
  game model across three; durable anchors across four), and 82% of tests land with their own file's majority.
- **Architecture tests.** Each reaches about 340 declarations, most of them ambient: hub traffic, logging, file reads,
  the type loader. Their clusters are weak, and async work one test starts can land in the next.
- **Selection.** Of 258 commits that changed source, unit tests reach the declarations of 98, and both suites together
  of 178. 80 change nothing any test reaches. Selecting every test that was running when a changed declaration ran
  picks a median 49 of 97 architecture tests, and 7 of the 8 suite files for 102 commits. Treating code reached at boot
  or by at least 30% of architecture tests as covered by any session (so it selects only the smoke suite) leaves 82
  commits needing the smoke suite alone and 7 needing all of them.
- **Not checked:** whether a selection would have skipped a test that went on to fail.

The design:
- **It's traces** (built 2026-10-23; editor RUNNING.md, *Tests*). A test is kept as a run is (`traces`' `test`: its
  id, the test file and its titles joined by ` › `, and its outcome), on each file it executed: the top-level
  declarations it ran there, by BABLR span. Keyed by the code's file, it's what selection reads: a diff names files,
  their traces name the tests. A file keeps each test's latest; shared at a commit while current, `merge=union`, as
  runs are. An edited declaration gets a new id, so selection looks a change up by the base version's ids. (It was to
  be a `tested` evidence kind; traces, by the same declarations as runs, replace it.) Tests run on tsval, in the editor
  (decision 3, decided).
- **Sets, not counters.** A test's reach is written when the set changes, so a run that reaches what it did before
  changes nothing in git. A declaration joins a test's set at once and leaves after N runs in a row without it. The
  count of misses is kept under `local/`. Architecture tests' ambient reach flickers with timing, and this keeps it from
  churning.
- **Outcomes in the run.** A test run is a run envelope with `tests` (each test's id: pass, fail or skip). Local runs
  stay local (they're frequent); CI's are shared. The failures over time are what checking a selection's safety needs.
- **Selecting.** A change's declarations (by the base version's spans) select the tests that reached them. Ambient and
  boot code select the smoke suite. A test with no record runs, with its static import reach as the floor. Ambient is
  relative to a suite's other tests, so it's worked out when read, not kept. So are clusters.
- **Trust.** Once CI gates on selection, a pull request could edit the records so its own tests are skipped. So CI
  selects with the records at the merge base, and counts only CI's own evidence (`evidence/ci/…`).

### Purity: decided statically, checked by runs (designed 2026-10-22, not built)

Which functions are pure, to show later (memoizing, replaying a call safely, explaining a function). Mostly decidable
statically, under assumptions that are written down:
- **Getters and setters:** no hidden side effects; accessors declared in the program are treated as calls.
- **Proxies:** none flow in.
- **Built-ins:** not monkey-patched. A table classifies them: `Math.*`, non-mutating string and array methods and `JSON`
  are pure; `push` and `sort` write to their receiver.
- **Types:** honest enough to resolve calls; a call through `any` comes out unknown.
- **Throwing and allocating** aren't effects.

A fixpoint over the call graph gives each declaration one verdict:

| Verdict | Meaning |
|---|---|
| pure | No writes outside its own allocations, no I/O, no nondeterministic reads (`Date`, `Math.random`, `crypto`) |
| reads-state | Pure, but reads mutable state from outside (memoizable only with invalidation) |
| mutates-args | Writes only to objects it was passed |
| pure-if | Pure if the callbacks it's given are; resolved where the callback is known |
| effectful | Anything else |
| unknown | Dispatch through an interface with many implementations, dynamic property access, `any` |

The I/O half is `reach`'s already (fs, net, exec, env); the rest goes beside it in lib's analysis, behind the
TypeScript seam. Static verdicts are recomputed, not kept: they say nothing the code doesn't.

Runs check it. tsval can observe purity, because it makes every assignment: it can tag what a call allocates and record
a write that escapes it, an effect, or a nondeterministic read. instrument.ts sees statements and values, not writes, so
code that runs in previews and the architecture suites gets the static verdict only. Observed purity is another
evidence kind at function spans, sharing the same files, merges and fading:
`{"kind":"purity","span":…,"calls":…,"impure":{"write":…,"effect":…,"nondeterministic":…},"first":{"kind":"write","at":…}}`.
Runs add three things:
- **Answers for unknowns.**
- **Counterexamples.** A write from a function judged pure means an assumption broke, which is a finding.
- **Confidence.** Phrased as insights' suggestions are: "seen 4,000 times, never impure", not "pure".

### Derived history: features, reach, what runs say (built 2026-10-12; the feature layer parked)

Commits are a poor record of change: they happen when tooling needs one (a push, CI, a deploy), so their messages become
noise, and keeping a useful history takes discipline. Here **history is derived from what the code is and does, never
written**, deterministically: fixed rules over computed facts, no model. Commits keep only their mechanical jobs
(checkpoint, transport, CI trigger); nothing depends on their ids or messages, so it survives rebase, squash and
force-push.

Three layers, each a pure function of the code's snapshots and the runs against it:

1. **Spans**, with an identity that follows them through moves and reformatting (BABLR; editor RUNTIME-EVIDENCE.md,
   *Durable annotations on spans*). Snapshots are git commits, or the editor's edit bursts.
2. **Features**: a way in (a command, view, setting, button, terminal command, URL parameter, agent tool, hub request or
   subscription, a core module) plus the code it reaches. Introduced when its way in appears, changed when code it
   reaches changes semantically, exercised when a run reaches it, removed when its way in goes.
3. **The story**: fixed sentences grouped by feature ("Added command *Rules: New Rule*", "Renamed setting
   `tsval.liveRuns` → `run.liveRuns`", "Tried the TestController coverage UI: added Oct 1, removed Oct 3").

**The first replay** (2026-10-12): 706 first-parent commits in 12 seconds, each file version parsed once and cached by
blob, no commit message read; its timeline wasn't kept (`silo history` writes it again). Oct 5–11's 116 commits became
89 sentences by area; 33 groups of "tried and removed" told this repo's experiments, which no commit message lists
(Preflight, comment annotations, the TestController coverage UI, the running status bar, Run with Inputs); the
`packages/vscode` → `packages/editor` rename read as "Moved 111 features".

Built since:
- **Reach** (`graph.ts`): a declaration graph — top-level declarations, imports and module bodies, each with an AST
  fingerprint so formatting isn't a change; edges are the names a declaration's code uses, imports resolved through
  re-exports and the program's own packages' `exports`. A feature's roots are the names its registration uses (a local
  of the registering function counts as what it's made from); a module body runs what it imports; workers' top-level
  listeners and hub names built at run time are ways in too. Each snapshot walks changed declarations (not merely moved
  ones) back to the features reaching them (`changed … via reach (file#name)`); one reaching five or more features is
  told once ("Changed `createArchReporter`, which 26 features use"). Silent commits over the history went from 457 to
  335 of ~720. Still to do: a call graph inside a declaration (using any name in a function reaches all of it).
- **TypeScript 7 reads the code**, behind one seam (`graph.ts`'s `DeclarationGraph` and `Analyzer`): one compiler for a
  whole replay, each snapshot a filesystem layer over the last, nothing checked out; the checker says what a name is.
  It found 2,362 feature changes to oxc's 2,081 (oxc is gone since 2026-10-14). Its one blind spot: a method reached
  through an interface-typed object resolves to the interface's member (the API has no "find implementations").
- **Live from edits** (`extensions/history`): its tsserver plugin reads the program the in-browser TypeScript server
  holds, unsaved edits included (`ts-analysis.ts`, `_history.read`), replays it on each pause and tells the History
  output channel what changed. **Nothing derived from edits is kept** (decided 2026-10-12): once you commit, the commit
  tells it; tries undone before any commit leave no trace.
- **What runs say** (`exercise.ts`): **exercised** (a statement of its own code ran: its registration's handler and the
  declarations it names, not what they reach further, nor the registering call), **dormant** (its file ran, its code
  never did), **unobserved**. Evidence is on BABLR spans, placed by the editor's resolver; `exercise.ts` compares those
  ranges with the TypeScript reading's, so analysis never touches BABLR.

Where: lib's `util/silo` — `features.ts`, `graph.ts`, `history.ts`, `exercise.ts`, `ts-analysis.ts`, and in Node
`typescript.ts` and `git-snapshots.ts`; the command line's `silo features [repo]` and `silo history [repo] [--since]
[--until]` (`--json`); the editor's `extensions/history`.

Not built: a feature's status and drift (the ledger, below); a history view by feature in place of the commit list;
the derived sentences as the message of whatever commit the tooling needs.

**Why it's parked: ways in beyond this repo.** A feature is a way in matched against a hand-written list of shapes
(`features.ts`) that's this repo's — VS Code's APIs, the hub, MCP tools, buttons — and a shape it doesn't know reads
as a removal (the terminal commands that moved to `command.ts` files show as "tried and removed"). Everything above it
inherits that gap. Three layers would carry it further: what every package declares (`exports`, `bin`, `scripts`);
presets switched on by dependencies (`vscode`, `@modelcontextprotocol/sdk`, `express`/`hono`, `commander`,
`react-router`); a repo's own shapes declared rather than coded (`{ "facet": "hub request", "call": "serve", "name": 1 }`).
Tests are a fourth: a way in every repository has, named by what it's for (*Which tests reach what*, above; NEXT.md,
features from tests). Also open: **names** (code says `installLiveValues`, people say "live values"; manifests' labels
help); **what counts as one feature** (features with the same reach are probably one). Prior art: Jujutsu (a change
keeps its id across rewrites), Unison (history per definition), Smalltalk's changes log and ENVY, xit.

### The feature ledger: code keeps its place, or goes (designed 2026-10-12, not built)

Code is easy to add and hard to remove: removing takes an argument, keeping takes none, so a codebase built fast keeps
everything it tried. A cleanup audit of this repo found almost nothing dead. The weight was code whose reason had lapsed
while nothing in the repo knew it: the capability engine, paused on Oct 2, still loading at boot and still changing on
Oct 10; Run with Inputs, removed (9482074) and still described in a doc. Each decision lived in a chat, so nothing could
check the code against it.

The ledger flips the default: **a feature keeps its place by having a current reason, a decision or evidence that it's
used; deleting it is priced, cheap and recorded.** Deterministic, like `features` and `history`: fixed rules over
computed facts, no model. It's Remember (what was decided) and Gate (the checks in CI).

- **The ledger:** `.silo/features.json`, shared, in `layout.ts`. Decisions only, not an inventory: a feature it doesn't
  name is kept by evidence alone. Statuses `active` (with a reason), `experiment` (with an `until`), `parked`,
  `stopped`, `removed` (a tombstone: where it went, why, and the command that restores it). An entry names a feature
  key (`command|tsval.explore`) or a name with `paths`; most code worth deciding about is reached from a way in rather
  than being one, so `paths` is first-class. `silo status <entry> <status> "<why>"`, or one click in the editor.
- **Drift (`silo check`):** stopped but present; parked but running (reached at boot) or changing (`history` says so
  since it was parked); experiment expired; removed but still named in a `.md`; dead ends (a button with no handler, a
  declared command nobody registers, a setting nobody reads); reached only by tests; an entry matching nothing (with
  `history`'s rename as the proposed key). Each finding names both ways out, change the code or the decision. Warnings
  first, errors one at a time once each is quiet here.
- **Prices:** what deleting a feature frees, the code only its entry reaches (what it dominates in the import graph,
  later the call graph): lines, files, bytes per realm, and on request measured boot and memory with it stubbed out.
  Shown on drift findings, dormant suggestions, and a pull request that removes code.
- **Leases:** a feature the ledger doesn't decide about stays while runs reach its code — a test, a run in the editor,
  an agent's tool call. It turns **dormant** when no test reaches it and, across enough runs that could have, none did
  (a smoke test that never signs in mustn't make sign-in dormant). Dormant is a suggestion with its price: Remove, or
  Keep with a reason that expires (90 days) and asks again.
- **Budgets:** bytes per realm beside the performance suite's; raising one is a line in the diff.
- **`silo remove` / `silo restore`:** remove takes out what only the entry reaches, its manifest entries and the
  tombstone, lists the docs that name it, and leaves a change for review; restore runs the tombstone.
- **Agents:** replacing an approach removes the old one in the same change; an experiment starts with an entry, so it
  expires by default; a scheduled run of `silo check` and the dormant list opens one deletion pull request a week.
- **In the editor:** drift in Problems; dormant features in the evidence's purple with their price, Remove and Keep.

Where it lives: lib's `util/silo` (`ledger.ts` for the file, the drift rules and lease state; `cost.ts` for prices — not
`reach.ts`, which is capability reach); the subcommands here; `silo check` in the lint workflow.

How it weaves into the rest: its leases are the traces runs and tests keep (`traces`, by span; NEXT.md, test runs
kept as traces), "could have reached" is selection's reach, and what one feature is comes from features from tests
(NEXT.md) — the ways-in list it was designed on is this repository's only.

Build order, each step useful alone: (1) the ledger and the checks that need no reach; (2) prices per area from the
import graph; (3) realm budgets; (4) leases; (5) `remove` and `restore`; (6) the agent rules and the weekly run.

Open: **off isn't stopped** (a flag off by default ships but doesn't run: its own status, checked by "never reached");
**restoring across a move** (a tombstone's paths mapped through the moves `history` detects); **what counts as one
feature** (often "a path set people name", not a way in).

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

(The questions above, "What doesn't fit", are otherwise answered by this design, except 7.)

From tests and purity (both above):

1. **Which job they are**, or whether there's a fifth ("What doesn't fit", 7).
2. **How CI's evidence gets into git.** A commit by CI when its reach sets change (rare once they settle), or git notes
   (`refs/notes/silo`, merged with git's own `cat_sort_uniq`), which stay out of main's history but outside the model
   where history is the committed `.silo/`.
3. ~~**What runs the unit tests.**~~ Decided 2026-10-23: tsval, in the editor first (`node --test` in its terminal, on
   its own node:test: editor RUNNING.md, *Tests*); silo's command line later through tsval's host, the one `silo run`
   needs. The same span ids as runs, and the only way tests can observe purity. The cost is speed (an interpreter);
   packages run natively.
4. **The architecture suites' shared session.** Tests run in order in one session, so one test's async work lands in
   the next. Waiting for quiet between tests, or a session per test, would make their reach their own; or accept it, and
   let ambient code select the smoke suite.
5. **The ambient line.** 30% of a suite's tests was one setting in the spike.
6. **Size.** Architecture tests reach about 340 declarations each: across 97 tests, tens of thousands of `tested`
   entries in the evidence files.
7. **Test identity.** A test is its file and full title; renaming one orphans its record until it runs again.
8. **A selection's safety**, which needs the failure history first.
9. **A subcommand, or not.** Selection could be `silo run`'s (`--changed`), or its own command, once it has a job.
10. **How much purity static analysis decides.** Unmeasured. The share of this repository's declarations that come out
    pure, effectful and unknown, and why the unknowns are unknown, says how much runs have to add.

