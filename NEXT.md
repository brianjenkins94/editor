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

Each item says what finishes it. One that has no such line yet waits on a decision, under *Decisions*.

1. **The editor's gaps, from using it.** Work on this repository and on example-consumer happens in the live editor,
   editor.unusuallygood.dev (each green `cd` deploys it, `EDITOR_DEPLOYS`); what it lacks is listed here as it's found,
   and errors and agents' tool use come in through the queue (CLAUDE.md, *The queue*). It began as two weeks of only that,
   to 2026-12-08, with no new test machinery meanwhile (2026-11-24); the user took the hold off 2026-11-26: "if that's
   where the next work takes us, that's fine". Open:
   - `npm run build` is `tsc && vite build`: `tsc` isn't a gap (the user, 2026-11-24: Problems has what it would say);
     `vite build` isn't one the editor's `vite` takes (it serves only), so example-consumer's test checks the pages as
     served, not built (the user's choice, 2026-11-26).
   - A repository with no ESLint config is held to the editor's own style rules (`object-shorthand` on its tests). Left as
     it is (the user, 2026-11-26): it belongs to a bigger decision about sensible defaults.
   - A signed-out editor isn't told its workspace is behind GitHub: the editor's requests to GitHub all need the sign-in,
     a public repository's fetch too (the offer to fast-forward, a4404c97, is signed in only).
   - Changes' *Commit* commits without pushing, and doesn't say so; the toolbar's *Commit and push* commits everything
     changed, so pushing a commit of some of the changes takes the terminal's `git push`.
   - The terminal has no `/tmp`, and can't make one (`mkdir -p /tmp/x` fails), though scripts expect it; and `cp -r` into
     it says it can't find its source (2026-11-26).
   - The terminal's `git commit` with nothing to commit says "fatal: EISDIR: illegal operation on a directory, open
     '/workspace'", not that there's nothing to commit (2026-11-26).
   **Done when** each gap listed is fixed or decided.
2. **Runtime evidence, used** (packages/editor/RUNTIME-EVIDENCE.md). Built: values, branches and types on
   hover, what could go, coverage, previews' evidence, time. But none is kept for this repository (no `.silo/evidence`),
   so nothing it says has been read in real work. In order: run this repository's own programs in it as it's used;
   decide from the diffs whether evidence is committed by default (its *Open questions*, the first); then the evidence
   diff (*Not built*: what an edit changed at runtime, a view first). **Done when** a week's evidence of this repository
   has been read and that default decided. First read (2026-11-26, the live editor, *Workspace filesystem*'s two unit
   tests from Features and Tests and the terminal): worth having on the code — the gutter's green and red (line 50's
   `return` never ran), the Margin's values (`coalesce` 22 of 22 calls, `prefix = '/workspace'`), the hover folding runs
   ("then never ran · else 4× (100%), in 4 runs"). As files to commit, not yet: five runs kept 272 lines, 51 KB, for four
   source files (`workspace-changes.ts`'s 21 KB, against the ~6 KB a 300-line file was expected to take), and a run of the
   same test on the same code rewrote every line of every file it reached (61 of 61, 113 of 113, 59 of 59: each line
   carries the last run's id and time and its decayed weights), so each run is a diff of everything it touched; and a
   line is a span's hash with counts, which a reviewer can't place. Decided (the user, 2026-11-26: "Stable lines"): committed is what
   was seen, the counts this machine's (RUNTIME-EVIDENCE.md, *Storage in git*; lib d7fc57b, d7a1ff5); a rerun that
   behaves the same changes nothing in git (evidence-hover.spec). The evidence diff is built (2026-11-26): Problems says what
   runs did since the last commit that they hadn't, on the code, edited or not (evidence-changes.spec); not what stopped.
   Next, high-confidence claims (the user, 2026-11-26: "contribute local evidence when it becomes high
   confidence"): what's contributed is a claim, not a count — a committed line gains `neverNullish`, `neverRan`,
   `onlyArm` or `pure` once the machine's counts back it past a bar, and loses it when a run breaks it, so a claim
   earned or broken is the diff and the counts still never are; a teammate's editor offers the quick fix on a claim
   alone. Open: the bar (the quick fix's own `minSeen` 10 and `minRuns` 3, or stricter for what others act on unseen,
   30+ runs: stricter, proposed), and that a quick fix needs no committed line anywhere contradicting it.
3. **Unused code, from a coverage run** (the user, 2026-11-25: "by having detailed coverage information we can eliminate
   unused code"). A dispatched architecture run records what each test ran,
   by statement, and `.silo/last-run/reach.json` keeps of it each file and the tests that ran any: what nothing ran is never
   asked, and the dormant check, which meant to (by way in), went 2026-11-25. In order: which realms and packages that run
   and the unit tests' reach don't measure (165 of 544 source files weren't in the record on 2026-11-24, 40 the API's and 23
   the theme's: a lead, not a finding); then the declarations no test ran, by feature, as something seen in the editor
   before a tool; then each one checked: nothing needs it and it goes, or it needs a test. What a person's runs reach counts
   as use too (item 2). **Done when** that list is empty of surprises: each entry removed, tested, or kept with why.
4. **Which tests a change runs, here** (the user, 2026-11-04: ideally the minimal set). Built: each test's reach kept
   (`.silo/local/reach/`), a change selecting by its changed lines and saying why for each file (`runs_affected`'s `why`,
   the table's touched), a UI spec's reach the editor it drives (`COVERAGE=1 npm run dev`). CI's specs aren't selected by
   reach: each boots the whole workbench (silo README, *Built*). Target, decided 2026-11-24: fewer than 10 of 80 commits
   run everything. Replayed 2026-11-24 over the last 80 by file, against `.silo/last-run/reach.json`: 26, from 34
   on 2026-11-16 — 20 for code nothing there reaches (types alone, as the debugger's protocol is, and modules that only
   re-export: run by no test, though their importers are; build and dev scripts), 3 a package.json, 3 a workflow.
   **Done when** the same replay says under 10; taking a file no test runs by its importers is
   most of what's left.
5. **Every test in the editor** (the end goal; the user, 2026-11-03). What's left stays outside, each for its reason
   (RUNNING.md, *Tests*); decided 2026-11-24 to leave it there. 141 of 176 unit test files pass in its debugger (2026-11-23).
   Four browser suites stay out: worker-realms.mjs (dist/ in fresh workers on the editor's origin), test/agent-tools/ (the
   agents' requests, no UI), test/workbench/ (what a page can't do to its own window) and performance.mjs (budgets).

## Watching

How each architecture test has gone in CI lately, failing and flaky first: `node test/outcomes.mjs` in
packages/editor (`--all`, `--runs N`, `--json`).

- **vouches.spec's commit found a run's evidence files after it** ("nothing to commit" expected, `.silo/evidence/…` and
  `.silo/runs/…` untracked: 2026-11-24, one of three full runs here; alone, 2 of 2).
- **evidence-kept's preview test missed its app's page once** (test/agent-tools/evidence-kept.mjs, "timed out waiting
  for the app's page", 2026-11-24, the second of three full runs of the split suites here; alone, 3 of 3).

- **The reach record is made by hand** (`.silo/last-run/reach.json`, what lets a file have several owners): from a
  dispatched coverage run and the unit tests' reach copied out of an editor; nothing in the editor writes it. As it is
  (2026-11-24, 1,834 tests), 10 files are run mostly by other features' tests, each for a reason: previews/page-evidence.ts
  goes into a page as text and request.ts's tests drive Chromium, so neither is counted; eight are bases.

- **packages/api's "a sign-in: the code for DPoP-bound tokens" failed once on CI** (be7d512a, "Body has already been
  read" reading `/me`'s answer, which nothing had read; green on its rerun, and here).
- **On a first load change-problems' recheck logs an error** (the live site, 2026-11-24: "TypeScript Server Error"), likely
  asked as TypeScript's projects reload for a package it had missed (versions.ts). Nothing shown; its span says it.

- **A type error shown 4 minutes, once** (2026-10-31): features-map.ts's `wa-card` (ts 2345, L157) resolves, but one
  run showed it after 4 minutes: likely TypeScript checking before type acquisition wrote Web Awesome's types, and never
  told after (ts-projects.ts skips node_modules). Unconfirmed; catch it happening before changing that. eslint.config.js's
  `@brianjenkins94/util/eslint` has no declaration file (ts 7016, a suggestion).
- **Capability findings on TypeScript 7** wait for TypeScript 7 to load a tsserver plugin (TypeScript's to do): then
  they move from the editor's TypeScript to it.
- **main's ruleset** (GitHub ruleset 26500207, 2026-11-03, in GitHub's settings, not this repository): pull requests to main
  need `silo / silo check`. Repository admins can bypass, so direct pushes and the editor's own commit flow keep working,
  and rely on `cd` not deploying after a red `ci`. Close that once the bench works through pull requests. A push from the
  editor's commit flow hasn't been tried against it: if one's refused, look here first.

- **silo as a reusable workflow** (`.github/workflows/silo.yml`, 2026-11-03): its default runs `packages/silo@latest.tgz`,
  published since (2026-11-23; installing it clean not tried again). lib adopts it next: a `silo` job in its ci, and its
  own ledger.

- **Reported errors, as of 2026-10-27** (the admin app's Errors pages; reporting fixed the same day: stack frames kept
  out of redaction, the workbench's errors with their stack, nothing reported once the page is going, a 7/30/90-day
  window). An error without a stack was grouped by its route alone, so dev's `Error` group (432eb90f62ef1ddc, 32)
  mixes unrelated failures: Web Awesome's `adoptedStyleSheets` NotAllowedError (a `wa-badge` in the Live architecture
  view, from before e86501b's `theme/documents`), promise rejections with an `ErrorEvent`, and production's `Missing
  method $init on worker thread channel default` (b9ca734, as monaco-vscode-api 38.0.2 was pinned). Whether the
  NotAllowedError still happens after e86501b is unknown: read the next reports, which carry their stack. Also seen
  once: `[almostnode] worker_threads.Worker is not implemented` (synckit's `createSyncFn`, e4e927b).

- **packages/api's "an email account without a password is told to use a code" test failed** in CI once ("a code was
  sent to someone-…@example.com", bc7a208, a workflow-only change; passed on rerun). The send's answer wasn't looked at,
  only the outbox after it: since 2026-11-22 the helper checks it (test/helpers.ts `byEmail`), so if it comes back it
  says why the code wasn't sent (throttled, paused) rather than that it wasn't. Not the sign-in rate limit, likely: each
  request comes from one of 254 addresses.

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
  on, a stray `break` ends the file there, and a malformed regular expression throws only when it's reached. TypeScript 6's
  checker reports all three (2451, 1105, and 1005 inside the pattern), on a one-file program with no lib (2026-11-22,
  13 ms for seven lines): a check before a file runs, at a checker's cost on every load, and only its grammar codes and
  2451, since others vary with the options and would refuse a valid program.

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

- **messages.spec's Output not shown** (2026-11-22: twice in full runs, and once in two alone; 2026-11-23 once in a full
  run, then alone it passed): the Output panel's view
  never had " → " for "the messages between the editor's contexts". Not the notes migration: every migrated file, printed
  without its comments, is the same code before and after (TypeScript's printer, 244 files). Not seen before today.

- **live-runs.spec misses in slow full runs** (here: "F5 just after a save" without its Debug Console output, 2026-11-19
  in 237 s against ~175, 2026-11-20 in 282 s, and 2026-11-22 twice, once in 239 s; "a rule gives it a value" without its value, 2026-11-23 three times, F5's with it once, 2026-11-20 in
  253 s).
  Each passes alone (15 of 15 for the spec, 2026-11-20) and in the next full run. On CI three times: F5's without its
  Debug Console output (6ceed7a3's `specs-2`, 2026-11-23, green on its rerun), and (0e885fc4's `specs-2`, and
  66b4a865's, 2026-11-24):
  "Pin…" (and locally 2026-11-23 in a full run, then alone), its F5 run given "seen" at its stop and the margin showing a live run's `skipped = exec ls` instead — a live
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
- **source-control.spec's commit didn't land in a slow full run** (here, 2026-11-21, 307 s against ~220; alone, it
  passed): after Ctrl+Enter its screenshot showed the message box emptied and all three files staged, none committed
  within 60 s, the page at 1.72 GB. Staged and the message taken, so the commit itself was slow or dropped.

## Decisions

- **Code from strings in a run** (queue item 5). Decided 2026-11-23: a debug run gives a program `eval`, as Node does —
  compiled in the run's scope (RUNNING.md, *Deterministic*); a direct eval's own scope isn't modeled, so it's global code.
- **Item 5's verdicts** (item 4 until 2026-11-24). Decided 2026-11-23, as proposed: what stays outside, the host its subject (in
  RUNNING.md, *Tests*); the tests that lacked only scaffolding change; the gaps a person's program would hit are fixed;
  a run has a `BroadcastChannel` of its own, Node's being the process's.
- **How few tests is enough** (queue item 4). Decided 2026-11-24: fewer than 10 of 80 commits run everything.
- **Several owners** (a queue item until 2026-11-24). Decided 2026-11-22: a file may be several features' if and only if real coverage
  shows it — each owner's tests running it, as the last run's reach has it (`.silo/last-run/reach.json`, kept by
  packages/editor/build/reach-record.ts), not static reach; otherwise it's split, or one feature's.
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
  from), production keeping the full editor by skipping only its deploy step (until 2026-11-24); the core is step 2's candidates plus
  running tests; the ledger holds what the manifest did (`what`, `docs`, `paths`, `ways`, `tests`) and becomes the
  source of truth, `silo check` erroring on drift; ownership by file, runs, tests and traces giving continuous
  coverage. Decided 2026-11-20: a note migrated from a comment is the repository's, its `git blame` author kept on it.

## Parked

- **The workspace's load cost** (parked by the user, 2026-11-22: not ready to). Each zen-fs lookup in the workspace's
  shared SingleBuffer walks from the root (StoreFS with `no_id_tables`, set for shared buffers); upstream won't keep
  id tables there before ECMAScript structs (#329, closed 2026-11-03). On 2.9.0 (2026-11-22, Node, this repository's
  2,597 files in 128 MB) a shared buffer writes them in 3.3 s against 0.74, stats each in 95 µs against 13, reads them
  all in 1.0 s against 0.16. Already done: the provider's `stat`, `readFile` and `readdir` ask once, and its stats are
  kept until a change says otherwise (workbench/stat-cache.ts: 32,490 of a reload's first 39,718). How it could come
  back: a path's inode kept per thread, dropped when a shared counter beside the buffer says another moved or removed
  one, on the StoreFS instance the workspace mounts; the numbers taken upstream; the file store's work in a worker. A
  first load measured 2026-11-11: the buffer at 32 of 128 MB, the first write-back 1.6 s, the restore 0.43 s (0.71 s,
  3,065 files, 2026-11-20).
- **The Event Sheet and building a game by painting a level** (far off, still the mission): what the editor is for,
  after the house is in order.
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
- **The terminal's first-hour commands and the tools agents expect** (2026-10-24: until someone asks for one; not
  `tsc`, the user, 2026-11-24): `eslint`, `curl`/`wget`, `man`, `date`, `ln -s`; `code_definition`,
  `code_hover`, `code_symbols`, `editor_open` (`runs_tests` and `code_references` are
  done). Conventions when one is
  asked for: workbench/terminal/catalog.ts, app/tools/host.ts.
