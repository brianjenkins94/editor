# Next

The work queued, in order. One list, so nothing open lives only in a chat or a memory. The design is in the docs each
item points to; this is only the order, and what done means.

How it's kept:

- **Done** is: committed, CI green, and the item deleted from this file in that same commit.
- **Found while working** — a flake, a gap, a follow-up — goes here, not into a chat.
- **Decisions only you can make** are under *Decisions*; an item waiting on one says so.
- **In parallel**: an item that waits on nothing above it can be a session of its own ("do NEXT.md item N"), which takes
  its line out when it lands.

## Queue

1. **Halt where nobody's watching.** A run selected after an edit (RUNNING.md, *Unattended runs*: "Built") that reaches an unsafe call with no recording halts there and
   leaves its question on the line (RUNNING.md, *Unattended runs*; *The `trigger` target* — live runs keep
   skipping). *Done:* such a run ends before the call, and the line offers *Rule…* prefilled
   *trigger is edit*.

2. **Replay matched by the whole request.** A recording is keyed by capability and resource only, so a POST and a GET to
   one URL share one. Key it by method, URL and a hash of the body (RUNNING.md, *What it needs*; *Open*,
   "Matching a recording"). *Done:* a POST's recording isn't given to a GET of the same URL.

3. **A picked run's coverage and run log.** Picking an older ball shows its values, but the gutter's coverage and the run
   log stay the latest run's (RUNTIME-EVIDENCE.md, *Live values, open*). Keep them with each run. *Done:* picking a ball shows its own.

4. **A writable layer per run.** An unattended run's file writes go to a layer of its own, thrown away when it ends
   (RUNNING.md *Open*). *Done:* a live run that writes a file leaves the workspace as it was, and its reads see its own
   writes.

5. **Purity, measured.** How much of this repository's code a static check calls pure / effectful / unknown, and why the
   unknowns are (packages/silo/README.md, *Purity*; decision 10 there). *Done:* the numbers, written into that section,
   and a go or no-go for building the check.

6. **Purity, built** — if 5 says go: the static check in lib's analysis (beside `reach`, behind the TypeScript seam), and
   tsval observing it at run time as a `purity` evidence kind (packages/silo/README.md, *Purity*). *Waits on:* 5.
   *Done:* a function's verdict shows beside it, and a run's write from a function judged pure is flagged.

7. **Values that didn't touch an input.** tsval tracks which values came from an input, so a run that read one can share
   the rest (RUNTIME-EVIDENCE.md, *Kept across reloads*: "Next"; lib traces `committable`).
   *Done:* a run that read a file shares the values it computed from its own literals.

8. **A result given to a preview's call.** A preview's fetches are decided at the service worker, real or denied; give
   one a rule's (or a recording's) result too, so an app can run unattended (RUNNING.md, *What it needs*; *A
   call's result*). *Waits on:* *Decisions* d. *Done:* a rule giving a fetch's result answers a preview's fetch.

9. **The ball as a run goes.** A long run's ball rolls while it runs, not only after (RUNTIME-EVIDENCE.md, *Live values, open*).

10. **The terminal's first-hour commands and the tools agents expect.** Commands people type within the first hour:
   `tsc` (the TypeScript server's diagnostics, printed as tsc does), `eslint` (the in-browser engine over the given
   files), `silo features|history` (util/silo over isomorphic-git snapshots), `curl`/`wget` (just-bash's `network`,
   gated by the capability rules), `man <cmd>` (its `--help`), `date` in the browser's time zone, and `ln -s` (or a
   plain "not supported"). Tools agents look for: `code_definition`, `code_references`, `code_hover`, `code_symbols`
   (VS Code's `execute…Provider` commands; today an agent greps), `editor_open` (show the user a file at a line),
   `tests_run` (node:test results as data), `silo_features`, `silo_history`. Conventions: workbench/terminal/catalog.ts,
   app/tools/host.ts. *Done:* each exists as its folder, with a test.

11. **Selection beyond a file's own tests.** A run of a program is kept only on its own file, so an edit to a module it
   imported doesn't select it: keep a run's trace on each file it executed, as a test's is, and select it the same way.
   And CI: select the architecture suites' tests by what they reached, ambient code (reached at boot, or by most tests)
   selecting the smoke suite only (packages/silo/README.md, *Which tests reach what*: "Selecting", "Trust"). *Done:*
   editing an imported module re-runs the programs that ran it; CI runs only the suites a change reached.

12. **unenv's own modules, audited.** Each miss so far (EventEmitter as a class; streams; string_decoder; assert with no
   messages and JSON equality, 2026-10-23) was a module unenv wrote itself rather than ported from Node, and Node's own
   code from npm replaced it (packages/almostnode/builtins.ts). Go through the rest it serves as they are — util,
   timers, url, querystring, os, buffer, the stubs — and for each that's hand-rolled where Node's code exists on npm,
   swap it in, with a test of the behaviour that differed. *Done:* every unenv module almostnode serves is a port of
   Node's, a stub that says "not implemented", or replaced, and builtins.ts says which.

13. **The feature ledger, steps 2–6** (packages/silo/README.md, *The feature ledger*: build order): prices per area
   from the import graph; realm byte budgets beside the performance suite's; leases from the traces runs and tests keep
   (dormant: reachable, never reached); `silo remove` and `silo restore`; the agent rules and a weekly `silo check` run.
   Also from step 1: drift in the editor's Problems view, and `silo check` in the lint workflow once it's quiet here.
   *Done:* each, as its step in the README says.

## Watching

- **isomorphic-git's "racy git"**: a same-size rewrite within the second it was staged goes unseen (the terminal's
  `git` test notes it; real git guards against it). Fix in the git engine if it bites.

- **tour-capabilities' `debug.start` hang** (pre-existing, rare: none in nine reruns). Starts take 0.4–3s in CI, so it's
  a hang, not slowness. When it fails, the error names the step it stuck on (d4ded28, a3f1ace): fix that step, then
  delete this.

- **`TextDocument.save()` returns false** from the extension API in the editor (seen in the architecture harness: the
  document stays dirty; Ctrl+S saves fine). Find out whether it's the harness or the editor; if the editor, queue the
  fix.

## Decisions

a. **The coverage spike's leftovers**: `packages/editor/build.ts`, `packages/editor/build/coverage.ts` and five lines
   in `test/architecture-harness.mjs`, uncommitted — commit them as an opt-in `COVERAGE=1` path, or drop them.
d. **An app's unattended run**: is the preview's reload on an edit (HMR) that run, its fetches replayed at the service
   worker? (RUNNING.md *Open*.)
e. **The rest of packages/silo/README.md's *Decisions to make*** (which job tests and purity are; how CI's evidence gets
   into git; test identity; size; a subcommand or not) — none blocks the queue above.
g. **RUNNING.md's open `trigger` questions** (*Open*): whether halting is an action of its own a rule can choose, and whether
   unattended defaults are rules silo seeds (visible, editable) or the evaluator's fallback (item 1).
h. **`eslint.workingDirectories`** (the ledger's first dead end, `silo check`): declared for parity with the desktop
   extension, never read (in the browser the workspace root is always the working directory). Keep it (`silo status`
   it active, with that reason) or take its declaration out.
