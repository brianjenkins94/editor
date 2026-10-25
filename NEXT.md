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

1. **CI's selection.** Select the architecture suites' tests by what they reached (build/coverage.ts, `COVERAGE=1`,
   instruments them; read each test's coverage from the realms the harness keeps), ambient code (reached at boot, or by
   30% of a suite's tests) selecting the smoke suite only, CI committing its reach when it changes
   (packages/silo/README.md, *Which tests reach what*: "Selecting", "Trust"; its *Decisions to make*). Selection is the
   editor's and CI's, not the silo command line's. (The editor's half — a program's run selected by an edit to a module it
   imported — built 2026-10-24.) *Done:* CI runs only the suites a change reached.

2. **unenv's own modules, audited.** Each miss so far (EventEmitter as a class; streams; string_decoder; assert with no
   messages and JSON equality, 2026-10-23) was a module unenv wrote itself rather than ported from Node, and Node's own
   code from npm replaced it (packages/almostnode/builtins.ts). Go through the rest it serves as they are — util,
   timers, url, querystring, os, buffer, the stubs — and for each that's hand-rolled where Node's code exists on npm,
   swap it in, with a test of the behaviour that differed. *Done:* every unenv module almostnode serves is a port of
   Node's, a stub that says "not implemented", or replaced, and builtins.ts says which.

3. **The feature ledger, steps 2–6** (packages/silo/README.md, *The feature ledger*: build order): prices per area
   from the import graph; realm byte budgets beside the performance suite's; leases from the traces runs and tests keep
   (dormant: reachable, never reached); `silo remove` and `silo restore`; the agent rules and a weekly `silo check` run.
   Also from step 1: drift in the editor's Problems view, and `silo check` in the lint workflow once it's quiet here.
   *Done:* each, as its step in the README says.

4. **Purity from runs.** Observed purity kept as evidence across runs (silo README, *Purity*: a `purity` kind at
   function spans, sharing the evidence files and their fading), so runs answer the static check's unknowns and give
   its verdicts confidence ("seen 4,000 times, never impure"). *Done:* a function the check calls unknown, run often
   without writing outside, shows that on its card.

5. **What came from an input, tracked at runtime.** The static floor shares values built only from a file's literals;
   tsval carrying a from-an-input bit with each value (through its value stack, bindings, objects and built-ins) would
   share every value that didn't touch one, a callback's and a parameter's included (RUNTIME-EVIDENCE.md, *Kept across
   reloads*; lib util/silo/purity `determinedValues`, the floor it raises). Measure first: what the floor misses on this
   repository's runs that read, and what the bit costs a run that reads nothing. *Done:* a run that read shares each
   value no input reached, and the cost to runs is in the performance suite.

## Watching

- **tour-runs' selection test timed out** in CI once, waiting for "calc.test.js run again, after the save" (1cc007e;
  passed on rerun; the features test after it failed on the state it left). It passed locally every time this session,
  and on 289dadd's run with the same code. If it comes back, find whether the save's selected run waits behind the
  file's own run or ESLint's fix on save.

- **tour-capabilities' package prompt timed out waiting for the baseline** once in CI (af79463; passed on rerun). The
  baseline is made as the project opens, from the CDN; the same run's log has CDN fetches failing. If it comes back,
  find whether the baseline waits on a fetch that failed, and make the test (or the baseline) say so.

- **isomorphic-git's "racy git"**: a same-size rewrite within the second it was staged goes unseen (the terminal's
  `git` test notes it; real git guards against it). Fix in the git engine if it bites.

- **tour-capabilities' `debug.start` hang** (pre-existing; none in nine reruns, then on 6e60505 and a74004d in a row).
  Both times the second start of *a gated call asks on its line* (Skip, right after Deny's run ended with EACCES) stuck
  at "followed, waiting for its first stop" (`Session.settled`): once it answered 30 ms later with no reason, once never.
  The whole tour passes locally (24/24). The assertion now prints the outcome's state, line and output: read it on the
  next failure, fix that step, then delete this.

- **`TextDocument.save()` returns false** from the extension API in the editor (seen in the architecture harness: the
  document stays dirty; Ctrl+S saves fine). Find out whether it's the harness or the editor; if the editor, queue the
  fix.

## Decisions

None open (the last ones settled 2026-10-24: their answers are in the docs above them).

## Parked

- **The terminal's first-hour commands and the tools agents expect** (2026-10-24: until someone asks for one): `tsc`,
  `eslint`, `silo features|history`, `curl`/`wget`, `man`, `date`, `ln -s`; `code_definition`, `code_references`,
  `code_hover`, `code_symbols`, `editor_open`, `tests_run`, `silo_features`, `silo_history`. Conventions when one is
  asked for: workbench/terminal/catalog.ts, app/tools/host.ts.
