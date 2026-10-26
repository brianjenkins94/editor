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

1. **What came from an input, tracked at runtime.** The static floor shares values built only from a file's literals;
   tsval carrying a from-an-input bit with each value (through its value stack, bindings, objects and built-ins) would
   share every value that didn't touch one, a callback's and a parameter's included (RUNTIME-EVIDENCE.md, *Kept across
   reloads*; lib util/silo/purity `determinedValues`, the floor it raises). Measure first: what the floor misses on this
   repository's runs that read, and what the bit costs a run that reads nothing. *Done:* a run that read shares each
   value no input reached, and the cost to runs is in the performance suite.

2. **Dormant features in the editor.** What `silo check` lists as dormant, shown where the evidence is (the feature
   ledger's "In the editor": the evidence's purple, with its price, Remove and Keep), so a lease runs out where the code
   is read rather than only in CI's lint. *Done:* a dormant way in is marked at its registration, and Keep / Remove
   there write the ledger as `silo status` / `silo remove` would.

## Watching

- **packages/api's "an email account without a password is told to use a code" test failed** in CI once ("a code was
  sent to someone-…@example.com", bc7a208, a workflow-only change; passed on rerun). If it comes back, find what a
  second test's sign-in code reaches in the first's mailbox (a shared mail stub, or an address not unique enough).

- **tour-runs' selection test timed out** in CI once, waiting for "calc.test.js run again, after the save" (1cc007e;
  passed on rerun; the features test after it failed on the state it left). It passed locally every time this session,
  and on 289dadd's run with the same code. Again on 05ce05b: *halt*'s selected run never halted on rates.js (passed on
  rerun and locally) — a second test waiting on a save's selected run. If it comes back, find whether the save's
  selected run waits behind the file's own run or ESLint's fix on save.

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
