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

1. **The refactor bench: refactor this repo in the editor, reading from and committing to GitHub.** It loads: the clone
   of `brianjenkins94/editor` (2,212 files) arrives in about 2 s, and an editor is open in under 10 s. Its
   dependencies are in node_modules as npm puts them (ARCHITECTURE.md, *Packages*):
   - `file:` siblings are linked;
   - Pages tarballs are unpacked;
   - registry packages are pinned in `.silo/versions.json` and load from the CDN;
   - type acquisition reads every package's manifest and tsconfig.

   features-map.ts went from 32 TypeScript errors to 2, and a linked file has one name. Still open:
   - **Doesn't run in the browser:**
     - `silo check`: rolldown's native binding;
     - the theme budget test: `child_process.execFileSync`;
     - `process.exit`, which the debugger's `process` doesn't have.

     CI on a pushed branch checks the work instead.
   - **Type gaps left:** features-map.ts's `wa-card` isn't in `HTMLElementTagNameMap` (Web Awesome's element types
     come from no import), and `registerCustomView`'s callback parameter is `any` (the `@codingame` types behind
     components/monaco-vscode-api). Not yet looked at.
   - **The repo's eslint.config.js** fails to load (`filenameOrUrl.startsWith is not a function`), so the preset lints.
   - **Load cost:** the workspace buffer is at 49 of 64 MB once this repo's types are in. On a dev build, the page's
     main thread was busy for minutes after a load: TypeScript resolves the whole monorepo now, and 1,733 packages are
     pinned for the baseline to read. Not profiled: the long-frame observer couldn't get a turn.
   - **Bugs found on the way:**
     - With `2>&1 | tail`, the error printed nothing.
     - `git log -3` is refused (`-n 3` works).
     - The editor writes `.silo/baseline.json` and `.silo/capabilities.json` into the loaded repo. They're untracked,
       so a `git_commit` without files would commit them.
     - The Margin pane draws inside the references peek.

   The steps left:
   - (b) Push: done. The proxy allows `git-receive-pack` (a pack up to 32 MB). The workbench's isomorphic-git pushes
     through the shell (`git.remote`, shell/git-push.ts), and commits are by the signed-in GitHub user
     (`git.identity`). The terminal has `git push` / `switch` / `checkout`, and agents have `git_push`, `git_branch`
     and `git_checkout`.

     First real push, 2026-10-27, from editor.unusuallygood.dev to `bench/first-push`: a new branch, then a
     fast-forward. It found two bugs, both fixed:
     - the first commit was by the placeholder: the identity was asked cold, while the page was still loading, and
       timed out; it's now asked as the git service starts;
     - four executable scripts went out as 100644: the workspace's filesystem keeps no executable bit, so HEAD's are
       now given back before each commit.

     `bench/first-push` (2be5c8a with the lost modes, then efaec74) is a scratch branch to delete. Still to decide:
     what becomes of the shell's Commit button (`commitFiles`, one REST commit of the whole workspace) now that a push
     exists.
   - (c) The `code_*` tools under *Parked* (references, rename, move with imports, code actions), on VS Code's
     providers plus `applyEdit`.
   - (d) CI on the pushed branch checks the work.

## Watching

- **CI's smoke-app shard has been cancelled at its 15 minutes on every run since 377b14b (push from the editor)**: four
  runs, two commits, against 5 minutes on 52a881b. The tours take the time they did before, and lib didn't publish in
  between, so it's 377b14b. The job slows as it goes: 7 s, 15, 25, 55 and 60 s a test on d593144, against 1–10 s on
  52a881b, until the three preview-window tests time out (a new window, one dropped on the editor area, one popped
  out). Its page-time changes:
  - the shell's `serve` of `git.remote` / `git.identity`, in its mount-once effect;
  - the git service's second RPC client, and `git.push` / `git.branch` / `git.checkout`;
  - three page tools.

  Nothing in them explains a growing cost. A local run in CI mode stalled 11–17 minutes between normal tests (this
  Mac sleeping, likely), so it showed nothing. Next, if it's taken up: bisect on CI, with throwaway branches each
  reverting one of those. Deploys still go out (cd and production pass).

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

None open (the last ones settled 2026-10-26: their answers are in the docs above them).

## Parked

- **The terminal's first-hour commands and the tools agents expect** (2026-10-24: until someone asks for one): `tsc`,
  `eslint`, `silo features|history`, `curl`/`wget`, `man`, `date`, `ln -s`; `code_definition`, `code_references`,
  `code_hover`, `code_symbols`, `editor_open`, `tests_run`, `silo_features`, `silo_history`. Conventions when one is
  asked for: workbench/terminal/catalog.ts, app/tools/host.ts.
