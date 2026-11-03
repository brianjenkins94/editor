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

1. **The refactor bench: refactor this repo in the editor, reading from and committing to GitHub.** Its first job is
   item 3's rebuild, and what that takes is the product, for any repository (ARCHITECTURE.md, *The bench does it*):
   a step it can't support is a gap here. It loads: the clone
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
     in our patch, 2026-10-30); meanwhile the provider's readdir stats every child for VS Code's listings. zen-fs 2.8's SingleBuffer v2 (on it since 2026-11-02, our
     cross-realm lock ported) doesn't change this. BABLR isn't reached in those 4 minutes.
     Profiled again 2026-10-31 (a first load of this repository, 4 minutes, the main thread's samples attributed to
     their owners): ~75% is zen-fs resolving paths, almost all of it asked by VS Code's file service through the
     workspace provider (workspace-fs.ts) — `readdir` 52 s (zen-fs stats each entry to list it, and the provider stat'd
     each child again), `stat` 19 s, `readFile` 3 s — then persistence's write-back 14 s and the load's writes 7 s. Git
     (~1 s), type acquisition (<1 s), the hub (4 s) and observability (2 s) are small. The provider's second stat is
     gone (zen-fs 190 s → 150 s). Counted the same day, the provider's calls over a 4-minute load: ~190,000 for 14,000
     paths, most of them whole-tree walks by our workspace search (components/monaco-vscode-api/workspace-search.ts:
     every `findFiles` walks the tree, uncached). The steady one, a walk a second from 140 s on, was history's manifest
     watcher re-reading every package.json for each one type acquisition wrote into node_modules: it skips those now,
     and a burst is one reading (`readdir` 55,300 → 7,700, `stat` 117,500 → 69,600). The extension host's calls,
     counted by caller 2026-11-02 (its outgoing RPC hooked in a cold load, 4 minutes): 16,752 `stat`s, 99.9% of them
     tsserver's module resolution relayed by VS Code's TypeScript extension (`fileSystem/stat`, a blocking round trip
     each), mostly node_modules probes — directories, `.d.ts`, `.ts`/`.tsx`/`.js` per import — and 3.8 per distinct
     path (4,412: `/workspace/node_modules` 313 times, a missing `@types/node_modules` 121); its reads 4,054 of 1,449
     files, listings 1,390, watches 1,899. Next by count, silo.history's readManifests: 2,319 reads of nearly every
     file, 1,325 of them packages/tsval/vendor. At ~0.14 ms a v2 lookup the stats are ~2–5 s of the load's 54 s of
     main-thread work, before VS Code's own cost per call. Cheapest cuts: the provider answering a path's stat from
     a cache its change path invalidates (16.7k → ~4.4k lookups), and history reading only the files that can hold a
     manifest. zen-fs's id tables would make each lookup ~10× cheaper (measured on 2.7.6: statting the repo's 2,249
     files 248 ms → 25 ms) — asked upstream (#329). Then the file store's work in a worker. On zen-fs 2.8.3 (2026-11-02) a cold
     first load (a fresh browser context) settles later: at 74–75 s against 58–62 s on 2.7.6 (the repository in the
     explorer at 5 s either way; 54 s of main-thread work against 46–51 s). zen-fs alone is ~30% slower on its v2,
     patched or not (this repository's 2,258 files: write 2.8 → 3.7 s, stat 1.2 → 1.6 s, read 1.0 → 1.3 s, readdir
     1.9 → 2.5 s), so it's v2's own cost, not our lock: upstream's to hear of.
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
2. **The editor's tests in the editor** (debug-mcp `runs_tests`, one file at a time in the tsval debugger; it answers
   within 50 s, done or not, and is waited on again by its run id). Passing in Brave, 2026-11-01: architecture-model,
   code, collab-identity, event-sheet, game-anchors, game-rules, git-fast-forward, sourcemap, span-annotations, and the
   terminal's git, history, less, node and ps; npm and terminal-session since 2026-11-02 (just-bash's sandbox: its context
   carried across awaits, a run's own global, a returned promise adopted in the return's context); page-tools since
   2026-11-02: a run's WebSocket to a server of its own is joined to it in the run, as Node's reaches its own machine,
   and seen — each frame and its close on the architecture view as that server's traffic (`server:<port>`), the
   connection a span. (A preview's WebSocket to a run's server still goes to the network; it'd be seen the same way.)
   preview-instrument, replay and silo-kept too, a run's package installs no longer waiting on a busy page (git
   status walks only what a run wrote; a package's dependencies fetched with it): cold — a fresh browser context, no
   HTTP cache — silo-kept takes 4.2 s, warm 4.0 s (it was 17.7 s). Still failing:
   - Can't run in a browser: baseline (execFileSync).

   These tests go with the rewrite (item 3): what's worth fixing here is the runtime they find wrong, since the rebuilt
   tests run, and are vouched for, in the editor.
3. **The rewrite, in place, worked in the editor** (packages/editor/ARCHITECTURE.md, *The rewrite, in place*). Done
   from the editor, by people or agents over debug-mcp; what the editor can't do for it goes here as its own item.
   Waits on items 1 and 2 being good enough to work in. In order:
   - **Before the reduction: what the rehearsal found** (2026-11-02, on `cosmetic`: measured, declared, removed with its
     test, reintroduced with a test of its own and its whys as notes, all through the editor and its agent tools; the
     branch `rehearsal/cosmetic`, never pushed, was lost when a reload cloned over it — the repo binding read from the
     workspace took an unanswered origin for "not this repository", fixed below). Fixed as found: the editor's reset and
     its repo binding read from the workspace (216bfc89); notes' threads remade ~60 times a second (each thread's input
     editor counts as visible, and every visibility change re-showed every note); the Margin's gutter overlay taking
     the clicks meant for VS Code's comment icons and folding. Fixed after (2026-11-02): an address replaces only a
     workspace that's no repository's clone (an unanswered origin keeps it; another repository's asks); the reset counts
     commits no remote has (`git.unpushed`); the shell's logs and spans reach debug-mcp (`shell`); a span that throws
     logs an error inside it (lib util/logger); every hub request is a span, its trace carried to the server
     (`observability.call` / `.serve`); History's tools open a TypeScript file to start TypeScript when none is; agents
     have `files_delete` and `notes_add`; notes and runs are authored by the signed-in GitHub user (the workspace's git
     config says who); a refused push or pull says the remote's reason (the 403 didn't come back: a push from localhost
     works). Still to do, by the step it blocks:
     - *Working in it at all:* one agent session per machine drives the editor (debug-mcp's port), and a session that
       couldn't start one has no tools with nothing saying why; two tabs back from a reset both cloned into one
       workspace; a tab sometimes missing from `tabs_list`.
     - *Measure:* a reset deletes the local test traces, so `runs_affected` knew nothing (905 files untraced); CI's reach
       covers the architecture suites only, and there `activate` is reached by nearly every test; `decisions_for` named five
       features for one file; nothing shows code with its comments stripped (the zero-knowledge pass's first
       condition); the clone is one commit deep, so `git_log` sees nothing older.
     - *Declare:* no way but editing `.silo/features.json` by hand, and no fields for ways in or tests (decision 21);
       `silo check` can't run in the editor.
     - *Remove:* every save runs ESLint's fix-all, rewriting
       lines an edit didn't touch (an import moved, a line split and left unindented) — review by hunk kept them out.
     - *Reintroduce:* the editor's `npm test` didn't collect an extension's own `test/` (added on the lost branch); a
       note on a `for` anchored to its loop variable; nothing tests an extension's wiring (activate → read →
       badge) short of the architecture harness — the old tour step did, end to end, the new unit test doesn't; the
       Explorer didn't list files an agent wrote until a reload.
   - **Visibility first**, so the rewrite is measured from its start: a span at every filesystem boundary, with its
     caller, duration, bytes and parent (*Visibility*). Done when the 2026-10-30/31 load questions are answered from
     `metrics_query` and `logs_query` alone. It serves item 1's load cost too, so it can go ahead of the rest.
     Before it, so the spans CLAUDE.md asks for (*Spans*) count (a throwing span and hub requests: done 2026-11-02):
     - span names from their file's path (CLAUDE.md, *Spans*): lib's `logger/span-names` (util/eslint.ts) is built
       and this repository's spans take it already; the editor's lint holds them once lib publishes util.
   - **Measure, while all the code is there**: what of the scope BABLR parses, a sample of its comments sorted into
     dropped, kept, note, and note citing a doc, and the zero-knowledge baseline on 3–5 features (the code alone
     against the code as it is). And the whole test suite run one last time, in CI and in the editor, for each test's
     reach and outcome: what each feature's tests held it to, once they're gone.
   - **The boundaries**: one feature to an extension, the candidates in *The architecture, reassessed* decided split
     or kept, each "stays because" reason checked again.
   - **Silo, firmed up** (*Silo, firmed up*): each capability under a job and a front end; the manifest's readers moved
     to declared features and attribution, or removed; silo README's *What doesn't fit* answered; decision 21.
   - **Notes for comments, and agents reading them**: the migration, notes in `decisions_for`, inline in `files_read`,
     an orphan warning from `files_edit`. Then the pass's third condition, to show notes lose nothing.
   - **The standard**, from the pass's gaps.
   - **Reduce to the core** — started 2026-11-02 on the branch `reduction`, in the editor. Done: the composition roots
     cut to the core (the workbench's extensions and services, build.ts, the app realm, the shell's top bar, the agent
     tool families); what the core no longer reaches deleted with its tests and theme surfaces; CI's architecture
     workflow down to `realms` and `performance`. Then the bridge and History split, one job each: the bridge is core's
     runtime crossing into VS Code (the uplink, capability decisions and stops, the workspace runtime, the run
     contract's events, the terminal's auto-attach); History reads the program and holds the ledger to it (drift in
     Problems, `history.decisions`); code-reach.ts became decisions.ts. What removed features left in the core went
     (notes.add, "Your edits", Share's workspace.files, BABLR's annotations). 45 features are tombstoned in the ledger;
     the 10 more the core keeps are declared there; `silo check` agrees. The core boots, loads this repository and runs
     its tests in the editor (git's, reset's, the workspace's: 20 of 20); the editor's unit tests pass in Node (94 of 94).
     And the shell split: shell.tsx is its core (the page, the dock, the hub, the theme, the review panel; 1,111 lines to
     307), and each other part of the top window a feature module started and placed from one list (shell/feature.ts:
     sign-in, repo load, the GitHub popover, Commit, Reset, the push's serves, error reports). And previews out: the node
     worker (the in-browser dev server), the preview taps, the service worker's preview routing and gate, the runner's
     preview hooks and the COVERAGE=1 build; `vite` is a command the terminal says isn't here; the four preview features
     tombstoned. CI's suites pass locally (realms 4 of 4, performance 5 of 5: boot 1.4 s, a typed hover 1 s, a 1000-file
     load 0.9 s; memory read from the metrics plane through debug-mcp now).
     The reduction moved `packages.tarball` from evidence.ts to tarballs.ts, whose feature it is, with a span per fetch.
     Left, in order:
     - *What's still in the manifest:* tsval's Playwright tests and site sums, the workbench's Live architecture view and
       extensions by URL, and the extension template's — the core keeps them; they move to the ledger with the rest of
       the manifest (*Silo, firmed up*). A debug run's own server is still answered (editor-api's runtime link), asked by
       nothing until previews come back.
     - *Docs:* ARCHITECTURE.md, RUNNING.md and RUNTIME-EVIDENCE.md describe the full editor still, but where `silo
       check` caught a removed file named.
     - *Then:* the core's tests written again, the first of the new suite; `EDITOR_DEPLOYS` set to `off` (production
       keeps the full editor) and the branch landed on main.
     Found while reducing: the editor's runner can't run the theme's budget test (`Unsupported encoding: latin1`) or a
     test that hooks `vscode` (`registerHooks` isn't in almostnode's `node:module`); `git_checkout` can't switch to a
     branch the shallow clone hasn't fetched (`git.show` fetches one; checkout should too); `git_pull` reports
     "diverged" when main moved under a branch (a merge in the editor would settle it); the editor's GitHub Apps
     couldn't push a change to `.github/workflows` (workflows read/write added to both apps 2026-11-02); writing the
     ledger has no editor UI yet (the tombstones were written with silo's own code from a checkout); the editor reloaded
     itself three times under large edits (8:24, 8:39, 8:46 pm): Vite's socket closed on both frames at once and its
     client reloaded the page, while the dev server and debug-mcp kept running — the work in the workspace survived,
     the calls in flight didn't; `files_edit` has no line-range cut, so a 360-line cut is 360 lines in the call (the
     longest cuts were made from a checkout); `runs_stop` doesn't stop a `runs_tests` run (a test that starts a server
     hung in the editor's runner); `files_grep`'s scope argument is `glob`, and `editor_problems` has no severity
     filter (cspell's infos drown the rest — moot now cspell is out).
   - **Reintroduce, one feature at a time, only with a purpose**: declared, built to the standard, spans, notes, its
     tests written again (declared, each with its own state, checked against what its old tests reached), vouched in the
     editor's commit flow, its pass run again. The first is the standard's worked example. Each is its own item here
     when it's next.
   - **Agent-only tools** (CLAUDE.md, *Agent tools*; found 2026-11-02): each gets the editor UI it mirrors, or goes,
     as its feature is reintroduced. `code_query` and `code_rewrite` (no command), `code_problems` (Problems shows the
     current set, not a change's), `code_reach` and `decisions_for` (Remove's lightbulb shows only what one way in
     alone reaches), `code_move` (nothing found that fixes imports on an Explorer rename), `git_blame`, `runs_affected`
     and `runs_ledger` (the tests-by-feature list would be their view), `workspace_checkpoint` and `workspace_restore`,
     `editor_trace`, `previews_provoke` (a test harness), `logs_query`, `logs_wait` and `spans_query` (no searchable
     view; the monitor has rates, the architecture view traffic), and `payloads_capture`. `git_log`, `git_show`,
     `runs_tests` and `script_run` have the terminal (`git`, `node --test`, `node`), which agents gave up on 2026-10-27;
     `page_eval` and `page_query`, the browser's devtools.

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
  declared feature; the AI-written manifest is superseded, 2026-11-02).
- **The rewrite** (packages/editor/ARCHITECTURE.md, *The rewrite, in place*). Decided 2026-11-02: in place, in this
  repository, worked in the editor; reduced to a minimal core, then features reintroduced one at a time with a
  purpose, no allowance for undeclared code; code no feature explicitly owns is an error (silo README, decision 22);
  the test suite eliminated and rebuilt with the features, declared, so CI can run fewer of them by resting and
  vouches.
  Decided 2026-11-02 too: main is reduced, the last full state tagged `full-editor` (and fetched by the editor to read
  from), production keeping the full editor by skipping only its deploy step; the core is step 2's candidates plus
  running tests; the ledger holds what the manifest did (`what`, `docs`, `paths`, `ways`, `tests`) and becomes the
  source of truth, `silo check` erroring on drift; ownership by file, runs, tests and traces giving continuous
  coverage. Open: whose a note migrated from a comment is (the repository's, or its `git blame` author's).

## Parked

- **Tests inside the editor's real extension host** (2026-11-02): an extension's tests run where it does — the
  editor's extension host, with VS Code's real API — as VS Code's own test runner runs extension tests inside one,
  rather than against a stand-in. Until then an extension's wiring is tested in Node against a small fake of the API
  (packages/editor/test), which grows only as extensions need it.
- **What the agent is doing, in the editor** (2026-11-02): a view of the agent's work as it happens — the files it reads
  and edits, the command it runs, failures — as [claude-files-pane](https://github.com/Marius-Adam/claude-files-pane)
  shows beside Claude's chat, drawn from debug-mcp's `agent` spans (the editor's tools at its transport, the rest from
  Claude Code's hooks: packages/debug-mcp/agent-hook.mjs). Parked until the spans have run a while.
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
