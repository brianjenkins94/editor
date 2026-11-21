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
   item 2's rebuild, and what that takes is the product, for any repository (ARCHITECTURE.md, *The bench does it*): a
   step it can't support is a gap here. It works: a clone of this repository in ~2 s and an editor open in under 10 s,
   its packages in node_modules as npm puts them (ARCHITECTURE.md, *Packages*), commits pushed through the editor's
   sign-in, pulls that fast-forward, review by hunk, `silo check` in its terminal (19 s), CI's outcome in its status bar,
   and no shell for agents (ARCHITECTURE.md, *Workspace tools*). Still open:
   - **Load cost** (a first load of this repository, last measured 2026-11-11: the workspace buffer at 32 of 128 MB, the
     first write-back 1.6 s, the restore at boot 0.43 s). What's left, by gain: each zen-fs lookup walks from the root
     (StoreFS with `no_id_tables`, off for shared buffers), ~10× cheaper with id tables — asked upstream (#329); since
     2026-11-20 the provider's `stat`, `readFile` and `readdir` ask once (a path found 3 lookups → 1: zen-fs's
     `existsSync` is two), and its stats are kept until a change says otherwise (workbench/stat-cache.ts: 32,490 of a
     reload's first 39,718 stats answered so, this repository with TypeScript loading it); then the file store's work in
     a worker. The
     restore's span (`editor.workbench.workspace-fs.restore`, 2026-11-20): this repository's 3,065 files, 698 folders, in
     0.71 s of a reload. zen-fs 2.8's v2 is ~30% slower than 2.7.6 on its own
     (write 2.8 → 3.7 s, stat 1.2 → 1.6 s for 2,258 files), patched or not: upstream's to hear of.
   - **Type gaps** (2026-10-31): features-map.ts's `wa-card` (ts 2345, L157) resolves, but one run showed it after 4
     minutes: likely TypeScript checking before type acquisition wrote Web Awesome's types, and never told after
     (ts-projects.ts skips node_modules). Unconfirmed; catch it happening before changing that. eslint.config.js's
     `@brianjenkins94/util/eslint` has no declaration file (ts 7016, a suggestion).
2. **The rewrite, in place, worked in the editor** (packages/editor/ARCHITECTURE.md, *The rewrite, in place*). Done
   from the editor, by people or agents over debug-mcp; what the editor can't do for it goes here as its own item. The
   reduction landed 2026-11-03 (4fbb0f68, `full-editor` the tag before it), every code file has one owner (decision
   22), the measures were taken (`.silo/zero-knowledge.json`, `.silo/last-run/`), and the features came back to rough
   parity with `full-editor` (the user's objective of 2026-11-05: that list ended 2026-11-19 with *Formatting-only
   changes marked*). In order:
   - **The boundaries** (ARCHITECTURE.md has the reasons, checked 2026-11-03: nothing split). Left: whether tsval can
     give up the workspace buffer, by a whole suite's timing through its link (3.4 s against 3.9 s on one file).
   - **Silo, firmed up** (*Silo, firmed up*): each capability under a job and a front end; silo README's *What doesn't
     fit* answered. One owner a file is where that starts: once silo ingests coverage from runs and traces, reassess
     sharing from what they show (packages/admin/src/views.tsx, four features' pages under one owner, is a known case).
     `silo observed .silo/local/reach` compares each test's reach with the ledger (2026-11-17: 149 tests, a median of
     100% in their own features' code, 26 under half, mostly a dependency). CI's reach, from a dispatched architecture
     run (2026-11-20, 44800937124: half the specs, the other half past the limit, 60 min since), each spec its own file's
     now: 41 tests to tell, a median of 17% in their own features' code — review-panel, checkpoints, way-in-reach and
     code_parses 79–98%; capability-findings, instances and cosmetic 0–2%, their features' code run by every editor and so
     not counted, what's left the terminal and review they lean on. `activate`, reached by every test, says nothing to
     it (`RARE`: a statement at most 10% of the tests ran).
   - **Notes for comments, and agents reading them**: the migration. Then the pass's third condition, to show notes lose
     nothing. An edit that orphans a note says so (2026-11-20: files_edit, files_write and files_replace answer
     `orphaned`, as Problems says "A note lost its place"). Agents read them (2026-11-17): `files_read` with the notes
     beside its lines, `decisions_for` with a file's among its whys. What the measure found to go on (2026-11-03, 128
     comments in 9 files): 53% dropped (JSDoc saying what a declaration's name and body do), 39% notes (whys, gotchas, a
     contract with another file, history), 6% notes citing a doc, 2% kept (a pragma, an `eslint-disable` with its
     reason); every file's header a note. The zero-knowledge baseline: the code alone 12 of 15, as it is 14.5 — every
     point the comments carried a why. A migrated note is the repository's, its comment's author kept on it (decided
     2026-11-20).
   - **The standard**, from the pass's gaps.
   - **Which tests to run at all** (the user, 2026-11-04: ideally the minimal set). Built: each test's reach kept
     (`.silo/local/reach/`), a change selecting by its changed lines and saying why for each file (`runs_affected`'s
     `why`, the table's touched), a UI spec's reach the editor it drives (`COVERAGE=1 npm run dev`). Not yet trusted:
     every commit of the last 80 touched a file no test here reaches; replayed, 34 of them would run everything (code
     nothing reaches, package.json, the workflow). Next: reach for what's untested here, the UI specs' most; then rerun as
     you write, checking coverage and capability expansion (silo README).
   - **Every test in the editor** (the end goal; the user, 2026-11-03). Four browser suites stay outside, each for a
     reason a spec can't take away: worker-realms.mjs (dist/ in fresh workers on the editor's origin), agent-tools.mjs
     (the agents' requests, no UI), workbench.mjs (the system's colour scheme, the architecture plane, sign-in with the
     API stood in for: a `route` of the editor's own would move it) and performance.mjs (budgets, from outside). Of the
     unit tests across the repository (measured 2026-11-04, 124 files), what holds the rest in the debugger: the Worker
     runtime (`workerd`, `miniflare`: packages/api, 170 tests), real Playwright launching a browser (78), `registerHooks`
     (73), stalls (52), the capability policy on `/tmp` and `exec` (32).
   - **What reintroduced features left for later**: Features and tests without coverage or per-test effects (its filter
     came 2026-11-20; CI's outcomes 2026-11-21: each file's tests' last verdicts, runs green and flakes on the branch,
     read from GitHub's logs through the sign-in, workbench/ci-outcomes.ts — 963 of this repository's 2,694 CI tests
     join a file the ledger names, the rest's titles worked out as they run or shared by two files) (`touched` and
     `resting` are item 3's); *Capabilities confirmed by runs* without its static half
     (whether the code could still make the call: a sweep of the project), the baseline's join, or capabilities by
     feature; *Capability findings* moving to TypeScript 7 once it loads a tsserver plugin; *Tests at once*' flag from
     what a test touches (the gate's effects) rather than last runs.
   - Far off, still the mission: *Event Sheet*, *Build a game by painting a level*.
3. **Fewer tests, by vouches and rest** (packages/silo/README.md, *Tests by feature, in your face*). Waits on item 2:
   what's vouched for is the rewrite's declared tests. Decided 2026-10-29 (*Decisions*, *Tests by feature*): a vouch is
   made at commit time, per person, by the tests run in the editor, and names the declarations each ran, so it lapses
   when that code changes; a test rests after 20 green runs, with a weekly full run; CI reruns a vouched test after 7
   days. Built so far is only what it stands on: tests run in the editor (`runs_tests`, the in-editor specs), the ledger
   declares each feature's tests, and runs record their reach. Not built: vouches, `touched` and `resting`, and CI
   reading them, the `silo` subcommand CI calls (decision 20). Decided 2026-11-20: decisions 15, 17–20 (silo README).
   Done when a push's CI runs fewer tests because the rest are vouched for or resting.

## Watching

How each architecture test has gone in CI lately, failing and flaky first: `node test/outcomes.mjs` in
packages/editor (`--all`, `--runs N`, `--json`).

- **main's ruleset** (GitHub ruleset 26500207, 2026-11-03, in GitHub's settings, not this repository): pull requests to main
  need `silo / silo check`. Repository admins can bypass, so direct pushes and the editor's own commit flow keep working,
  and rely on `cd` not deploying after a red `ci`. Close that once the bench works through pull requests. A push from the
  editor's commit flow hasn't been tried against it: if one's refused, look here first.

- **silo as a reusable workflow** (`.github/workflows/silo.yml`, 2026-11-03): its default runs `packages/silo@latest.tgz`,
  and the tarball published now can't install (`file:../bablr`; fixed, not published, as deploys are off). A clean install
  of one built locally ran on this repository, on lib (its ledger declares nothing, so it passes) and failed a stray file
  in a repository declaring a feature. lib adopts it once deploys are on: a `silo` job in its ci, and its own ledger.

- **When deploys are on again** (`EDITOR_DEPLOYS` is `off`, so no tarball has published since 2026-11-03): the first
  publish of `@brianjenkins94/app-window` is the first bundled one (util-publish bundles a package that names a
  `customElements` manifest, everything inlined but its peers). Checked locally against lib's script and
  example-consumer; `example-consumer` installs from `@latest`, so it's what proves the published one. It needs a
  `util` with that publish.ts published first. The retired `toolbar`, `caption`, `code` and `frame` tarballs stay on
  Pages at their last versions, and stop updating.

- **Reported errors, as of 2026-10-27** (the admin app's Errors pages; reporting fixed the same day: stack frames kept
  out of redaction, the workbench's errors with their stack, nothing reported once the page is going, a 7/30/90-day
  window). An error without a stack was grouped by its route alone, so dev's `Error` group (432eb90f62ef1ddc, 32)
  mixes unrelated failures: Web Awesome's `adoptedStyleSheets` NotAllowedError (a `wa-badge` in the Live architecture
  view, from before e86501b's `theme/documents`), promise rejections with an `ErrorEvent`, and production's `Missing
  method $init on worker thread channel default` (b9ca734, as monaco-vscode-api 38.0.2 was pinned). Whether the
  NotAllowedError still happens after e86501b is unknown: read the next reports, which carry their stack. Also seen
  once: `[almostnode] worker_threads.Worker is not implemented` (synckit's `createSyncFn`, e4e927b).

- **A repository load the browser closed on is kept half-written** (2026-10-31): a load's files are written back to
  IndexedDB in debounced batches (workspace-fs.ts `flush`), and a browser closed in the middle keeps what landed — here
  `.git/HEAD`, `.git/config` and acquired types, no working tree. The shell's note of what it loaded (`shell:githubRepo`
  in localStorage) outlives it, so an `env/` address finds "already loaded" and opens an empty workspace. Fixed by
  hand (the note cleared, the repo cloned again). If it comes back: mark a load complete only once its files are all
  written back (the origin alone can't tell: `.git/config` is among the first written).

- **packages/api's "an email account without a password is told to use a code" test failed** in CI once ("a code was
  sent to someone-…@example.com", bc7a208, a workflow-only change; passed on rerun). If it comes back, find what a
  second test's sign-in code reaches in the first's mailbox (a shared mail stub, or an address not unique enough).

- **isomorphic-git's "racy git"**: a same-size rewrite within the second it was staged goes unseen (the terminal's
  `git` test notes it; real git guards against it). Fix in the git engine if it bites.

- **A file made on disk doesn't join the TypeScript project** (found 2026-10-29) until a language feature asks of it:
  VS Code's TypeScript extension builds the watchers its browser server asks for from `Uri.file(path)`, and that
  server names files by URI (`/file/ts-nul-authority/workspace/…`), so it watches nothing; the changes it does pass on
  are plain paths, which the server doesn't name either. A file a checkout, a pull or the terminal makes has no
  TypeScript problems, no importers in `code_problems` and no reading in History until it's opened. Worked around
  since 2026-10-29: core watches for code files made or deleted and tells the projects (ts-projects.ts,
  `_history.files`). The fix is the extension's path mapping in its watcher (the vendored build,
  components/monaco-vscode-api).

- **tsval runs some files V8 rejects** (found 2026-11-04): a file the parser rejects now fails at its load, as in Node, but what
  V8 calls early errors and TypeScript leaves to its binder and checker aren't the parser's to report. Tried: `let a; let a;` runs
  on, a stray `break` ends the file there, and a malformed regular expression throws only when it's reached.

- **A save can be dropped, silently:** VS Code abandons a save when its code actions on save are cancelled, and
  getCodeActions cancels itself when a code action provider is registered while it waits (as extensions starting up do). Seen
  2026-11-04, on CI's first saves. ESLint's fix doesn't wait for its worker to load, and saves again when it sees that cancel
  (`extensions/eslint/extension.ts`). Another provider that's slow to answer could still lose a save. The agents' `files_edit` /
  `files_write` still try again (workspace-tools.ts `applyAndSave`).

- **The in-editor specs' renderer** (found 2026-11-10): every spec's editor is a frame of one page, so they share its
  renderer, which kept about 60 MB a spec that never came back (not JavaScript: at the end of a run that held 6.2 GB,
  `measureUserAgentSpecificMemory` found 0.8 GB live, the outer editor alone), and near 9 GB it crashed. Measured one
  spec at a time (2026-11-17), little stays: the climb was two specs' editors live at once, and a popup left open as its
  editor went (theme `src/popups.js`). So the specs run one at a time in each session (two here, one on CI: test/in-editor.mjs),
  a renderer peaking near 5 GB. What's left to shrink is the editor itself: each runs its own TypeScript servers, ESLint, BABLR and
  so on.

- **A new terminal didn't come in preview-profile.spec on CI** (1b36c848 and 4e9ae421, 2026-11-10): Terminal: Create New
  Terminal, and no `.xterm-rows` within 30 s. Both times beside preview-devtools.spec, which opens a terminal of its own at
  the same point, in the same page: the palette closes when its window loses focus, and an Enter then runs nothing. Not
  reproduced locally (three runs of the preview specs two at a time, CPU four times slower). editor.mjs's `openTerminal`
  now asks again if none has come in 15 s, and `runCommand` opens the palette again if it lost focus before Enter (not by
  its keys, Ctrl+Shift+`: with a file open that brought none). If it comes back, it wasn't the focus.

- **preview-session.spec saw no debug session** (local, 2026-11-10, once in three with the CPU four times slower and the preview
  specs two at a time): the dev server served its page, and the toolbar, the session list and the status bar had nothing.
  Again on CI 2026-11-16 (cde152ee's specs, 1 of 40: no Stop, `{"toolbar":[],"sessions":[],"status":[]}`), passing in five
  full runs here that day.

- **unpkg answered 404 for a file it has** (02be5dbc's architecture run, 2026-11-18): workbench.spec's "the service worker
  serves a package's file from the CDN" got 404 for `react@18.3.1/package.json` through the dev server's CDN proxy
  (build/package-types.ts `nodeModulesCdnPlugin`, unpkg), which unpkg served a few hours later. Its first. If it comes
  back, the proxy could ask jsDelivr when unpkg says 404, as the service worker's own CDN fallback might.

- **The workspace store and its packs** (measured 2026-11-19, this repository in Node, 20 commits pulled one at a time):
  nothing collects the packs a fetch brings, but a pull that fast-forwards adds ~70 KB, and this repository's clone
  leaves the store at 36 of 128 MB: over a thousand pulls of room. What filled it fast was a fetch that didn't move the
  branch (a `git fetch`, a pull that diverged or conflicts) sending every commit since again, 110 KB growing to 400 KB
  a fetch: it now names origin's tip as what it has (git-engine.ts `haveRef`). If the store does fill: collect by
  repacking what's reachable, which decides how much history a workspace keeps.

- **The editor reloaded itself under large edits** (2026-11-02, three times in an evening): Vite's socket closed on both
  frames at once and its client reloaded the page, while the dev server and debug-mcp kept running — the workspace's
  work survived, the calls in flight didn't. Not seen since. If it comes back: what closed the socket (the dev server's
  log at that moment), and whether the editor's own frames should take Vite's reload at all.

- **Two tabs loading one repository** (fixed 2026-11-19 for tabs that arrive together, as two back from a reset do): an
  address's load holds a Web Lock (shell/repo-load.tsx), and a tab that finds another loading says so rather than
  cloning too. A tab that arrives after the load ends but before its files are written back to IndexedDB still finds
  no repository in its copy, and clones: if that's seen, the load wants a signal that its write-back is done.

- **live-runs.spec misses in slow full runs** (here: "F5 just after a save" without its Debug Console output, 2026-11-19
  in 237 s against ~175, and 2026-11-20 in 282 s; "a rule gives it a value" without its value, 2026-11-20 in 253 s).
  Each passes alone (15 of 15 for the spec, 2026-11-20) and in the next full run. On CI once (0e885fc4's `specs-2`):
  "Pin…", its F5 run given "seen" at its stop and the margin showing a live run's `skipped = exec ls` instead — a live
  run on its interval landing between. All four came after specs had editors of their own again (f8f3b8db), each
  editor still starting as its test runs.

- **log.spec's Output filter not applied, with the CPU four times slower** (2026-11-20, `ARCH_CPU_THROTTLE=4`, the third
  log.spec in one session): "notes.look" typed in the Output's filter box, and the channel's lines still unfiltered in
  30 s. Not seen on CI or at speed here. Problems' box applies a change 300 ms on, and only while it's showing; whether
  the Output's does the same is the place to look.

- **Three CI misses in shared editors**, before every spec had an editor of its own again (2026-11-20): log.spec's
  Output didn't show (1bbba327's `specs-2`, after live-runs.spec), notes.spec's Problems row didn't (a3c3bea3's
  `specs-1`, after messages.spec: the status bar counted it), and way-in-reach.spec's below. None reproduced here, in CI's
  order in one session. If none comes back, they were sharing's; if one does, a failing spec's dump says what every editor
  showed, Problems' rows and filter among it (test/in-editor.mjs, `sayWhatHappened`), and notes.spec finds its row by
  Problems' filter.

- **way-in-reach.spec failed twice on CI** (d0cf69cb's lightbulb; 96bb5b36, 90 s, its error lost to the job's limit):
  it passes here alone and after type-queries.spec (CI's order) beside another session, in 6–9 s. Its lightbulb waits on
  History's read through TypeScript's server, which now has spans (`editor.extensions.history.read`, its `ready` and
  `count`; `.replay`), and test/in-editor.mjs prints a failing test's error as it fails: the next miss says which.
  A hover that didn't come once (cosmetic.spec's on CI, ef97772b; pane-views.spec's in a full run here) is hovered
  again from elsewhere now, as a person would (in-editor/editor.mjs, `hoverUntil`); why it didn't come isn't known.

## Decisions

- **Tests by feature**, silo's for any repository, the editor's rewrite first (packages/silo/README.md, *Tests by
  feature, in your face*). Decided 2026-10-29: the list view; touched tests run in the background, and before the
  commit what hasn't; declared tests only in the rewrite, best-effort attribution meanwhile; rest after 20 green runs,
  a weekly full run; CI reruns a vouched test after 7 days. Decided 2026-11-20 (silo README, 15 and 17–20): resting by
  test, by file for a suite that shares a session; the audit rate a setting that may be zero, the effort going into
  knowing which code warrants which tests; anyone who can push vouches; a vouch crosses runtimes only for a test whose
  outcomes have matched on both; CI calls a silo subcommand. Open: which runner reports silo reads first.
- **The rewrite** (packages/editor/ARCHITECTURE.md, *The rewrite, in place*). Decided 2026-11-02: in place, in this
  repository, worked in the editor; reduced to a minimal core, then features reintroduced one at a time with a
  purpose, no allowance for undeclared code; code no feature explicitly owns is an error (silo README, decision 22);
  the test suite eliminated and rebuilt with the features, declared, so CI can run fewer of them by resting and
  vouches.
  Decided 2026-11-02 too: main is reduced, the last full state tagged `full-editor` (and fetched by the editor to read
  from), production keeping the full editor by skipping only its deploy step; the core is step 2's candidates plus
  running tests; the ledger holds what the manifest did (`what`, `docs`, `paths`, `ways`, `tests`) and becomes the
  source of truth, `silo check` erroring on drift; ownership by file, runs, tests and traces giving continuous
  coverage. Decided 2026-11-20: a note migrated from a comment is the repository's, its `git blame` author kept on it.

## Parked

- **Docking editors into windows** (parked by the user, 2026-11-10: fine for now, another time). How it could come back,
  as proposed: full-editor's way was a dockview layout as the shell's main region, VS Code's windows and the previews its panels, but the previews are `app-window`s now, so that's a second kind of window. Instead: (1) VS Code's Move Editor into New Window opens in an `app-window` in the shell, as the previews do, through the component's `openAuxiliaryWindow` hook, still there and unused (its place kept, closing it as VS Code closes a window: a clean editor closes, a dirty one goes back); (2) a preview's window shown as an editor tab, full-editor's hosted-editor.ts with what it found (an inactive pane is taken out of the page, so the preview is laid over its pane, hidden but loaded); and (3) docking proper, a window snapped to the shell's edges or tabbed with another, in `app-window` itself if it's wanted, decided by use.
- **Tests inside the editor's real extension host** (2026-11-02): an extension's tests run where it does — the
  editor's extension host, with VS Code's real API — as VS Code's own test runner runs extension tests inside one,
  rather than against a stand-in. Until then an extension's wiring is tested in Node against a small fake of the API
  (packages/editor/test), which grows only as extensions need it.
- **What the agent is doing, in the editor** (2026-11-02): a view of the agent's work as it happens — the files it reads
  and edits, the command it runs, failures — as [claude-files-pane](https://github.com/Marius-Adam/claude-files-pane)
  shows beside Claude's chat, drawn from debug-mcp's `agent` spans (the editor's tools at its transport, the rest from
  Claude Code's hooks: packages/debug-mcp/agent-hook.mjs). Parked until the spans have run a while.
- **Logpoints in the editor's own code** (`debug_logpoint`, its values as data; deferred 2026-10-30, not dropped: we
  may want it once Playwright tests run in the editor). A logpoint
  needs a hook where it's set, and the editor runs as bundled code with no DevTools Protocol attached: it would take
  the coverage build's instrumentation (a hook at every statement, `COVERAGE=1`) carrying an expression to evaluate,
  in a dev build only. Meanwhile `editor_trace`, the logs and spans, and `page_eval` cover most of it.
- **The terminal's first-hour commands and the tools agents expect** (2026-10-24: until someone asks for one): `tsc`,
  `eslint`, `silo features|history`, `curl`/`wget`, `man`, `date`, `ln -s`; `code_definition`,
  `code_hover`, `code_symbols`, `editor_open`, `silo_features`, `silo_history` (`runs_tests` and `code_references` are
  done). Conventions when one is
  asked for: workbench/terminal/catalog.ts, app/tools/host.ts.
