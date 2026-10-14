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

## Modules nobody uses

These are in lib `util/silo`, but nothing in the editor, the command line or the rest of lib imports them:

- **`packages`**: a package's capabilities, from bundling the slice of it you import. It's the only thing that uses
  `deobfuscate`, so that's unused too in effect.
- **`guard`**: a runtime check at a boundary, with a pluggable reaction.
- **`provenance`**: how likely a file was written by AI. The prototype's original purpose (approving AI-written code),
  dropped on purpose: most code is AI-written now. `review` (which code units were reviewed, `review.json`) belongs
  with it; only `audit` still reads it.

All three came over from the `silo` prototype.

## What doesn't fit (open questions)

1. **The baseline may not analyze packages.** `audit.ts` says package capability probing was cut and lives in
   `packages.ts`, which nothing calls, and deobfuscation is reached only through it. Yet `install` says it records
   "what each installed package can do". Either the baseline gets its package facts some other way (to verify), or
   Anticipate is missing its core: static analysis and deobfuscation of the packages themselves.
2. **There's no gate outside the editor.** The editor gates its runs (tsval, almostnode) and util/mcp gates MCP tools,
   but nothing gates a program you run from a terminal. A `silo run` has been discussed (tsval with policy, recording
   exceptions) and not built. Not urgent while the editor (already a browser sandbox) is the product, but needed to
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
