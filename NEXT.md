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
   - registry packages are pinned in `versions.json` (in `.silo/local/` until the repository commits it) and load from
     the CDN;
   - type acquisition reads every package's manifest and tsconfig.

   features-map.ts went from 32 TypeScript errors to 2, and a linked file has one name. Still open:
   - **Doesn't run in the browser:**
     - `silo check`: rolldown's native binding;
     - the theme budget test: `child_process.execFileSync`;
     - `process.exit`, which the debugger's `process` doesn't have.

     CI on a pushed branch checks the work instead.
   - **Type gaps left** (seen again 2026-10-30, the repository loaded locally): features-map.ts's `wa-card` isn't in
     `HTMLElementTagNameMap` (ts 2345, L157) though it imports `theme/components/card`, whose types re-export
     `@awesome.me/webawesome`'s, so they don't resolve from packages/theme in the browser; `registerCustomView`'s
     callback parameter is `any` (ts 7044, L123: the `@codingame` types behind components/monaco-vscode-api, whose
     build isn't in git); and eslint.config.js's `@brianjenkins94/util/eslint` has no declaration file (ts 7016).
   - **The repo's eslint.config.js** gets past `createRequire(new URL(…))` now (almostnode, cb5922d0) and stops at
     `Cannot find module '@awesome.me/webawesome/dist/components/button/button.js'`: it lists Web Awesome's
     components from its installed files, and a registry package isn't on disk in the editor (the CDN serves it as
     it's used, and ESLint's worker has no network). So the preset lints. Either the workspace has the files a
     config reads (an install of what it resolves), or the config reads them another way.
   - **Load cost:** the workspace buffer is at 49 of 64 MB once this repo's types are in. Profiled 2026-10-30 (the
     harness's Chromium, a DevTools CPU profile of the load; logpoints on zen-fs's lookups and the file provider for
     who): the main thread is busy 100% for the 4 minutes measured. Fixed so far: git re-parsing .git/index for every
     file it checked, a read bumping zen-fs's ctime (b7430d91); and the load writing each file through VS Code's file
     service — a validation stat, two mkdirp walks and a listing of its folder per file, quadratic in a folder's size —
     now straight into the store, one batch to VS Code (provider calls 18.9k → 4.8k in the first 2 minutes); the change
     watcher's stat before a write's own touch, the boot seed's per-file folder check, and overlapping git status walks
     (one shared). An address's load now settles in ~3½ minutes rather than past 4 (zen-fs 193 s → 169 s). Still busy:
     each zen-fs lookup walks from the root, decoding every parent's listing (StoreFS with `no_id_tables`), ~10 per file
     written (the write, and the change watcher's checks around it), plus isomorphic-git's status walks. Next, by gain:
     zen-fs's own path cache — StoreFS's id tables, off for shared buffers (`no_id_tables`) — asked of upstream (not
     in our patch, 2026-10-30); meanwhile the provider's readdir stats every child for VS Code's listings. zen-fs 2.8's SingleBuffer v2 doesn't change this (measured; it
     also loses files across realms without our lock). BABLR isn't reached in those 4 minutes.
   - (b) Push: done. The proxy allows `git-receive-pack` (a pack up to 32 MB). The workbench's isomorphic-git pushes
     through the shell (`git.remote`, shell/git-push.ts), and commits are by the signed-in GitHub user
     (`git.identity`). The terminal has `git push` / `switch` / `checkout`, and agents have `git_push`, `git_branch`
     and `git_checkout`, and `git_pull`: a fast-forward to GitHub's branch when it can be one, keeping the working
     tree's changes (git-engine.ts `fastForward`), which the Commit button does before it commits.

     First real push, 2026-10-27, from editor.unusuallygood.dev to `bench/first-push`: a new branch, then a
     fast-forward. It found two bugs, both fixed:
     - the first commit was by the placeholder: the identity was asked cold, while the page was still loading, and
       timed out; it's now asked as the git service starts;
     - four executable scripts went out as 100644: the workspace's filesystem keeps no executable bit, so HEAD's are
       now given back before each commit.

     The shell's Commit button commits and pushes (2026-10-30): the workbench's `git.commit` with every change, then
     `git.push` of the current branch, in place of `commitFiles`'s one REST commit of the whole workspace. The scratch
     branch `bench/first-push` is deleted.
   - Review by hunk: done. `git_review` gives the changes as hunks with ids, BABLR's cosmetic verdict per hunk and the
     features each is in; `git_commit` / `git_discard` take hunk ids. The review panel runs on the same requests
     (`git.review`, and line picks as `except` / `rows`), so an agent's commits show up there.
   - No shell for agents: their shell tool is removed (2026-10-27; ARCHITECTURE.md, *Workspace tools*), so the bench is
     worked through the editor's tools alone, and what it still lacks is item 2's list. A program runs under `debug_start`.
   - (d) CI on the pushed branch checks the work.

2. **Tools agents decide with**, in place of the shell: one queue with the bench's step (c), in the order refactoring
   this repo in the editor needs them (2026-10-29). Each is a tool family under app/tools/ (host.ts). Done:
   `code_problems` (a change's problems against HEAD), `runs_affected` / `runs_tests` (the tests a change reaches, and
   results as data), `code_reach` (what a way in reaches), `code_references` / `code_rename` / `code_move`, `git_log` / `git_show` /
   `git_blame`, `files_replace` (exact strings across files, all or nothing; a `preview` of its diff), `editor_trace`,
   `workspace_checkpoint` / `workspace_restore`, structural `code_query` / `code_rewrite`, `decisions_for` (what the
   ledger, the manifest and the docs say of a file or a name), `ci_status` (a commit's runs, a job's log) and
   `script_run` (JavaScript over the workspace, read-only, in the gated realm); ARCHITECTURE.md, *Workspace tools*, and RUNNING.md,
   *Tests*. In order:
   - **(c) code actions** (`code_references`, `code_rename` and `code_move`, a file moved with its imports, are done:
     ARCHITECTURE.md, *Workspace tools*).

   Every one: relative to a baseline (HEAD, or the last call); ids that chain from tool to tool, as hunk ids do; output
   bounded, saying what it left out; and what it couldn't see (TypeScript still initializing, say) said, not passed
   off as complete.

## Watching

How each architecture test has gone in CI lately, failing and flaky first: `node test/outcomes.mjs` in
packages/editor (`--all`, `--runs N`, `--json`).

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
  TypeScript problems, no importers in `code_problems` and no reading in History until it's opened. Worked around
  since 2026-10-29: core watches for code files made or deleted and tells the projects (ts-projects.ts,
  `_history.files`). The fix is the extension's path mapping in its watcher (the vendored build,
  components/monaco-vscode-api).

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

- **Logpoints in the editor's own code** (`debug_logpoint`, its values as data; deferred 2026-10-30, not dropped: we
  may want it once Playwright tests run in the editor, which may mean an in-editor Playwright of our own). A logpoint
  needs a hook where it's set, and the editor runs as bundled code with no DevTools Protocol attached: it would take
  the coverage build's instrumentation (a hook at every statement, `COVERAGE=1`) carrying an expression to evaluate,
  in a dev build only. Meanwhile `editor_trace`, the logs and spans, and `page_eval` cover most of it.
- **The terminal's first-hour commands and the tools agents expect** (2026-10-24: until someone asks for one): `tsc`,
  `eslint`, `silo features|history`, `curl`/`wget`, `man`, `date`, `ln -s`; `code_definition`,
  `code_hover`, `code_symbols`, `editor_open`, `silo_features`, `silo_history` (`runs_tests` and `code_references` are
  done). Conventions when one is
  asked for: workbench/terminal/catalog.ts, app/tools/host.ts.
