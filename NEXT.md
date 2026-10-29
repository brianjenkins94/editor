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
   - Review by hunk: done. `git_review` gives the changes as hunks with ids, BABLR's cosmetic verdict per hunk and the
     features each is in; `git_commit` / `git_discard` take hunk ids. The review panel runs on the same requests
     (`git.review`, and line picks as `except` / `rows`), so an agent's commits show up there.
   - No shell for agents: their shell tool is removed (2026-10-27; ARCHITECTURE.md, *Workspace tools*), so the bench is
     worked through the editor's tools alone, and what it still lacks is item 2's list (step (c), the `code_*` tools,
     is its first). A program runs under `debug_start`.
   - (d) CI on the pushed branch checks the work.

2. **Tools agents decide with**, in place of the shell: one queue with the bench's step (c), in the order refactoring
   this repo in the editor needs them (2026-10-29). Each is a tool family under app/tools/ (host.ts). Done:
   `code_problems` (a change's problems against HEAD), `runs_affected` / `runs_tests` (the tests a change reaches, and
   results as data) and `code_reach` (what a way in reaches); ARCHITECTURE.md, *Workspace tools*, and RUNNING.md,
   *Tests*. In order:
   - **(c) `code_references`, `code_rename`, `code_move`** (a file moved with its imports) and code actions, on VS
     Code's providers plus `applyEdit`. This is also `code_reach` for a plain symbol that isn't a way in.
   - **`git_log`, `git_show`** (a file at a revision), **`git_blame`**.
   - **`files_edit_many`**: one WorkspaceEdit across files, all or nothing, each with the number of matches it expects.
   - **Code running, watched without editing it**: logpoints in the editor's own code (`debug_logpoint`, its values as
     data), and VS Code's trace log for one component (`editor_trace`). The save bug took six instrumented reruns
     where `TextFileEditorModel`'s trace says "cancelled" in one.
   - **Experiments that undo themselves**: `workspace_checkpoint` / `workspace_restore` (a throwaway overlay layer), and
     a dry run on edits (`preview`: the diff and the diagnostics it would add).
   - **Structural `code_query` / `code_rewrite`** on the syntax tree, in place of regex rewrites.
   - **`decisions_for`** (the ledger entries, ARCHITECTURE.md sections and NEXT.md items naming a file or symbol) and
     **`ci_status`** (a commit's runs, and a failed job's log).
   - **`script_run`**: JavaScript in the capability-gated eval realm, the workspace read-only, for the computation a
     script is for (counting, joining JSON). Its capability log shows what it touched.

   Every one: relative to a baseline (HEAD, or the last call); ids that chain from tool to tool, as hunk ids do; output
   bounded, saying what it left out; and what it couldn't see (TypeScript still initializing, say) said, not passed
   off as complete.

3. **The test ledger** (packages/silo/README.md, *Tests by feature, in your face*): every run of every test, its
   outcome, attempt, duration, runtime and where it ran, so "last failed", "flaky" and "green for N runs" are read, not
   remembered. Generic, in lib `util/silo` (records in, answers out), with runner reports read through adapters; this
   repository's CI first: its architecture shards and unit tests report outcomes, and CI commits the shared ledger as
   it commits reach records. It's what resting (after 20 green runs; a weekly full run), vouches and a selection's
   safety (silo's decision 8) wait on, and what would have tracked this week's flakes in place of *Watching*'s prose.
   Done is: CI records every test's outcome on main, and an answer per test (last failed, flaky, green streak) reads
   from it.

## Watching

- **Reported errors, as of 2026-10-27** (the admin app's Errors pages; reporting fixed the same day: stack frames kept
  out of redaction, the workbench's errors with their stack, nothing reported once the page is going, a 7/30/90-day
  window). An error without a stack was grouped by its route alone, so dev's `Error` group (432eb90f62ef1ddc, 32)
  mixes unrelated failures: Web Awesome's `adoptedStyleSheets` NotAllowedError (a `wa-badge` in the Live architecture
  view, from before e86501b's `theme/documents`), promise rejections with an `ErrorEvent`, and production's `Missing
  method $init on worker thread channel default` (b9ca734, as monaco-vscode-api 38.0.2 was pinned). Whether the
  NotAllowedError still happens after e86501b is unknown: read the next reports, which carry their stack. Also seen
  once: `[almostnode] worker_threads.Worker is not implemented` (synckit's `createSyncFn`, e4e927b).

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

- **A file made on disk doesn't join the TypeScript project** (found 2026-10-29) until a language feature asks of it:
  VS Code's TypeScript extension builds the watchers its browser server asks for from `Uri.file(path)`, and that
  server names files by URI (`/file/ts-nul-authority/workspace/…`), so it watches nothing; the changes it does pass on
  are plain paths, which the server doesn't name either. A file a checkout, a pull or the terminal makes has no
  TypeScript problems, no importers in `code_problems` and no reading in History until it's opened. Agents' `files_write`
  asks a new code file's symbols, which hands it over; `code_problems` asks the changed files'. The fix is the
  extension's path mapping in its watcher (the vendored build, components/monaco-vscode-api).

- **A person's first Ctrl+S after load can be dropped**, silently: VS Code abandons a save when its code actions on
  save are cancelled, and getCodeActions cancels itself when a code action provider is registered while it waits (as
  extensions starting up do; ESLint's first fix waits seconds for its worker). The agents' `files_edit` / `files_write`
  try again (workspace-tools.ts `applyAndSave`); a person's save isn't retried. If it's seen, warm ESLint's worker
  before the first save, or retry in a save participant.

## Decisions

- **Tests by feature**, silo's for any repository, the editor's rewrite first (packages/silo/README.md, *Tests by
  feature, in your face*). Decided 2026-10-29: the list view; touched tests run in the background, and before the
  commit what hasn't; declared tests only in the rewrite, best-effort attribution meanwhile; rest after 20 green runs,
  a weekly full run; CI reruns a vouched test after 7 days. Open: decision 15 (tests that lean on each other), 17–19
  (the audit rate, whose vouches count, different runtimes), 20 (CI's entry point) and 21 (what the ledger holds for a
  declared feature, and what becomes of the AI-written manifest).

## Parked

- **The terminal's first-hour commands and the tools agents expect** (2026-10-24: until someone asks for one): `tsc`,
  `eslint`, `silo features|history`, `curl`/`wget`, `man`, `date`, `ln -s`; `code_definition`,
  `code_hover`, `code_symbols`, `editor_open`, `silo_features`, `silo_history` (`runs_tests` is done; `code_references` is
  item 2's). Conventions when one is
  asked for: workbench/terminal/catalog.ts, app/tools/host.ts.
