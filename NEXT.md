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

1. **The smoke test's ext-log race.** "observability: an extension's log reaches the tree's collector" fails now and
   then: the harness keeps 5000 console lines and the bridge's `runtime.fs` traffic pushes the extension's line out
   before the test looks. Read it from `session.notable()` (the harness's buffer without that traffic, a3f1ace).
   *Done:* the smoke test reads `notable()`, and three architecture runs in a row pass it.

2. **Test runs kept as traces.** A test's run kept as a run's is (lib util/silo/traces: the declarations it executed, by
   span), so what each test reaches is known by the same unit as a live run. Designed as the `tested` evidence kind in
   packages/silo/README.md (*Which tests reach what*); traces replace that kind. *Done:* running a test file in the
   editor (or `silo`) keeps a trace per test, and its declarations match its coverage.

3. **Selection: what an edit reaches runs again.** On a save, the declarations it changed (their span ids gone from the
   text) name the kept runs and tests that executed them; those run again, unattended (RUNNING.md, *Unattended runs*:
   "What runs"). Ambient code (reached at boot, or by most tests) selects the smoke suite only (the spike's finding,
   README). *Waits on:* 2; *Decisions* b. *Done:* editing one function re-runs only the runs and tests that executed
   it, shown as balls on their files.

4. **Features from tests.** Group the kept test traces by what they execute into features, named by their tests (the
   spike's clustering: packages/silo/README.md, *Which tests reach what* — unit tests read as features, end-to-end tests
   are mostly ambient), and attribute code to them. *Waits on:* 2; *Decisions* f. *Done:* the editor shows a file's
   code by the features its tests say it belongs to.

5. **Halt where nobody's watching.** A run selected by 3 that reaches an unsafe call with no recording halts there and
   leaves its question on the line (RUNNING.md, *Unattended runs*; RULES.md, the `trigger` target — live runs keep
   skipping). *Waits on:* 3. *Done:* such a run ends before the call, and the line offers *Rule…* prefilled
   *trigger is edit*.

6. **Replay matched by the whole request.** A recording is keyed by capability and resource only, so a POST and a GET to
   one URL share one. Key it by method, URL and a hash of the body (RUNNING.md, *What it needs*; RULES.md *Open*,
   "Matching a recording"). *Done:* a POST's recording isn't given to a GET of the same URL.

7. **A picked run's coverage and run log.** Picking an older ball shows its values, but the gutter's coverage and the run
   log stay the latest run's (LIVE-VALUES.md *Open*). Keep them with each run. *Done:* picking a ball shows its own.

8. **A writable layer per run.** An unattended run's file writes go to a layer of its own, thrown away when it ends
   (RUNNING.md *Open*). *Done:* a live run that writes a file leaves the workspace as it was, and its reads see its own
   writes.

9. **Purity, measured.** How much of this repository's code a static check calls pure / effectful / unknown, and why the
   unknowns are (packages/silo/README.md, *Purity*; decision 10 there). *Done:* the numbers, written into that section,
   and a go or no-go for building the check.

10. **Purity, built** — if 9 says go: the static check in lib's analysis (beside `reach`, behind the TypeScript seam), and
   tsval observing it at run time as a `purity` evidence kind (packages/silo/README.md, *Purity*). *Waits on:* 9;
   *Decisions* c. *Done:* a function's verdict shows beside it, and a run's write from a function judged pure is flagged.

11. **Values that didn't touch an input.** tsval tracks which values came from an input, so a run that read one can share
   the rest (LIVE-VALUES.md, *Kept across reloads*: "Next"; lib traces `committable`). *Waits on:* 9's runner question
   (*Decisions* c). *Done:* a run that read a file shares the values it computed from its own literals.

12. **A result given to a preview's call.** A preview's fetches are decided at the service worker, real or denied; give
   one a rule's (or a recording's) result too, so an app can run unattended (RUNNING.md, *What it needs*; RULES.md, *A
   call's result*). *Waits on:* *Decisions* d. *Done:* a rule giving a fetch's result answers a preview's fetch.

13. **The ball as a run goes.** A long run's ball rolls while it runs, not only after (LIVE-VALUES.md *Open*).

## Watching

- **tour-capabilities' `debug.start` hang** (pre-existing, rare: none in nine reruns). Starts take 0.4–3s in CI, so it's
  a hang, not slowness. When it fails, the error names the step it stuck on (d4ded28, a3f1ace): fix that step, then
  delete this.

- **`TextDocument.save()` returns false** from the extension API in the editor (seen in the architecture harness: the
  document stays dirty; Ctrl+S saves fine). Find out whether it's the harness or the editor; if the editor, queue the
  fix.

## Decisions

a. **The coverage spike's leftovers**: `packages/editor/build.ts`, `packages/editor/build/coverage.ts` and five lines
   in `test/architecture-harness.mjs`, uncommitted — commit them as an opt-in `COVERAGE=1` path, or drop them.
b. **How much runs after an edit**: everything selection picks, or a budget (time, CPU), the rest left for later
   (RUNNING.md *Open*).
c. **What runs the unit tests for traces and purity**: the Node load hook, or tsval as a command line (the host
   `silo run` needs anyway) — packages/silo/README.md, decision 3.
d. **An app's unattended run**: is the preview's reload on an edit (HMR) that run, its fetches replayed at the service
   worker? (RUNNING.md *Open*.)
e. **The rest of packages/silo/README.md's *Decisions to make*** (which job tests and purity are; how CI's evidence gets
   into git; test identity; size; a subcommand or not) — none blocks the queue above.
f. **Where features from tests show**: a view of its own, the Margin's cards, or the Rules-like tree (item 4).
g. **RULES.md's open `trigger` questions**: whether halting is an action of its own a rule can choose, and whether
   unattended defaults are rules silo seeds (visible, editable) or the evaluator's fallback (item 5).
