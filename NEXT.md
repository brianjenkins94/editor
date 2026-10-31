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
   - **Doesn't run in the browser:** `silo check`. rolldown no longer stops it (the CLI loads it only for a baseline's
     slices), but its analysis is TypeScript 7, native only on npm until its wasm build is published
     (typescript-go#4733). CI on a pushed branch checks it instead. (`process.exit` and the theme budget test run now.)
   - **Type gaps** (2026-10-31, the repository loaded locally): features-map.ts's `wa-card` (ts 2345, L157) resolves —
     go-to-definition reaches theme's card.d.ts and from it Web Awesome's in the root node_modules, and the file has no
     2345 — but one run showed it after 4 minutes: likely TypeScript checking before type acquisition wrote Web Awesome's
     types, and never told after (ts-projects.ts skips node_modules). Unconfirmed; catch it happening before changing
     that. eslint.config.js's `@brianjenkins94/util/eslint` has no declaration file (ts 7016, a suggestion here).
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
     Profiled again 2026-10-31 (a first load of this repository, 4 minutes, the main thread's samples attributed to
     their owners): ~75% is zen-fs resolving paths, almost all of it asked by VS Code's file service through the
     workspace provider (workspace-fs.ts) — `readdir` 52 s (zen-fs stats each entry to list it, and the provider stat'd
     each child again), `stat` 19 s, `readFile` 3 s — then persistence's write-back 14 s and the load's writes 7 s. Git
     (~1 s), type acquisition (<1 s), the hub (4 s) and observability (2 s) are small. The provider's second stat is
     gone (zen-fs 190 s → 150 s). Counted the same day, the provider's calls over a 4-minute load: ~190,000 for 14,000
     paths, most of them whole-tree walks by our workspace search (components/monaco-vscode-api/workspace-search.ts:
     every `findFiles` walks the tree, uncached). The steady one, a walk a second from 140 s on, was history's manifest
     watcher re-reading every package.json for each one type acquisition wrote into node_modules: it skips those now,
     and a burst is one reading (`readdir` 55,300 → 7,700, `stat` 117,500 → 69,600). Still: ~44,000 `stat`s from an
     extension host one file at a time (MainThreadFileSystem.$stat), uncounted by caller. zen-fs's id tables would make
     each lookup ~10× cheaper (measured on 2.7.6: statting the repo's 2,249 files 248 ms → 25 ms) — asked upstream
     (#329). Next: who makes those stats; then the file store's work in a worker.
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
     worked through the editor's tools alone (ARCHITECTURE.md, *Workspace tools*, has them all). A program runs under
     `debug_start`.
   - (d) CI on the pushed branch checks the work.
2. **A `.locator` call on the preview, for agents** (packages/playwright). Playwright tests run in the debugger against
   the preview you have open (2026-10-31; packages/editor/RUNNING.md, *Tests*); an agent tool for one locator call or
   action on a preview window (`playwright.run`, with its `window`) is what's left, when an agent needs one.

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

- **CI's smoke-app shard runs out of its 15 minutes on CI's slower runners** (since 10-30 at least). It isn't a
  commit: across 13 runs the build's time (the runner's speed) says how it goes. A Vite build of 3.7–4.2 s passes in
  about 5 minutes; 6.0–6.5 s (1.6 times slower) is cancelled or fails every time, on neighboring commits either way.
  On a slow runner it snowballs: the app suite's first test takes twice as long, its eleventh 80 times (73 s against
  0.9 s), so work is queuing up faster than it clears. The page's CPU throttled 3× here (`ARCH_CPU_THROTTLE=3`, the
  harness) doesn't reproduce it: all 13 pass at 1–5 times their time, no growth. So what queues is outside the page
  (workers, the dev server, the node side: throttling slows only the page), or needs more than 3×. Next, if it's
  taken up: a CPU profile of a slow runner's run (CI), or throttling the workers too. Deploys still go out (cd and
  production pass).

- **The workspace store's ceiling** (2026-10-31): it's one fixed 64 MB SharedArrayBuffer (workspace-fs.ts
  `BUFFER_BYTES`), and zen-fs's SingleBuffer takes ~2.5× the files' size (this repository's 9 MB tree wrote 22.5 MB;
  live, 26 MB of files — tree 8.5, types in node_modules 12.7, .git 3.2, .silo 1.3 — take 54 MB). So ~25–30 MB of
  files is the practical limit; this repository is near it. A bigger buffer costs nothing until it's used (measured in
  V8: a 512 MB SingleBuffer mounted and filled with this tree used the memory a 64 MB one did), so raising the constant
  is the cheap fix — not done yet (2026-10-31, decided to wait). zen-fs can't grow a buffer in place (it reads the size
  once); a growable SAB would need that upstream. The fill gauge (editor-metrics.ts `workspaceFill`) reads the
  allocator's high-water mark, freed space included, so it overstates how full the store is.

- **A repository load the browser closed on is kept half-written** (2026-10-31): a load's files are written back to
  IndexedDB in debounced batches (workspace-fs.ts `flush`), and a browser closed in the middle keeps what landed — here
  `.git/HEAD`, `.git/config` and acquired types, no working tree. The shell's note of what it loaded (`shell:githubRepo`
  in localStorage) outlives it, so an `env/` address finds "already loaded" and opens an empty workspace. Fixed by
  hand (the note cleared, the repo cloned again). If it comes back: mark a load complete only once its files are all
  written back (the origin alone can't tell: `.git/config` is among the first written).

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
  may want it once Playwright tests run in the editor, item 2). A logpoint
  needs a hook where it's set, and the editor runs as bundled code with no DevTools Protocol attached: it would take
  the coverage build's instrumentation (a hook at every statement, `COVERAGE=1`) carrying an expression to evaluate,
  in a dev build only. Meanwhile `editor_trace`, the logs and spans, and `page_eval` cover most of it.
- **The terminal's first-hour commands and the tools agents expect** (2026-10-24: until someone asks for one): `tsc`,
  `eslint`, `silo features|history`, `curl`/`wget`, `man`, `date`, `ln -s`; `code_definition`,
  `code_hover`, `code_symbols`, `editor_open`, `silo_features`, `silo_history` (`runs_tests` and `code_references` are
  done). Conventions when one is
  asked for: workbench/terminal/catalog.ts, app/tools/host.ts.
