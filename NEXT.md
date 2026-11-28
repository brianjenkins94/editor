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
   High-confidence claims are built (2026-11-26; the user: "contribute local evidence when it becomes high
   confidence", "start"; lib d29938b): a committed line gains `neverRan`, `neverNullish`, `onlyArm` or `pure` once
   this machine's counts pass 30 runs and 100 tries (the stricter bar proposed), and loses it when a run breaks it; a
   teammate's editor offers the quick fix on a claim alone, and not when any committed line contradicts it
   (RUNTIME-EVIDENCE.md, *Storage in git*). Not yet seen: a claim earned in real use (30 runs of one thing).
3. **Unused code, from a coverage run** (the user, 2026-11-25: "by having detailed coverage information we can eliminate
   unused code"). A dispatched architecture run records what each test ran,
   by statement, and `.silo/last-run/reach.json` keeps of it each file and the tests that ran any: what nothing ran is never
   asked, and the dormant check, which meant to (by way in), went 2026-11-25. In order: which realms and packages that run
   and the unit tests' reach don't measure (165 of 544 source files weren't in the record on 2026-11-24, 40 the API's and 23
   the theme's: a lead, not a finding); then the declarations no test ran, by feature, as something seen in the editor
   before a tool; then each one checked: nothing needs it and it goes, or it needs a test. What a person's runs reach counts
   as use too (item 2). **Done when** that list is empty of surprises: each entry removed, tested, or kept with why.
   What isn't measured (2026-11-26, the record of 2026-11-24 against the tree: 207 of 589 source files not in it):
   - **Not counted, though run** (28): a module whose only code is `export default {…}`, as each terminal command's
     definition is, had no statement coverage counts; it does now (almostnode's instrument.ts). Types-only modules have
     nothing that runs, so nothing to measure.
   - **Tests that ran outside the record** (72): the API's (46 files, 33 test files, under Node), the theme's (24), the
     site's and eslint-plugin-webawesome's.
   - **No tests at all** (21): admin (17), account, bablr (3).
   - **Tooling** (about 45): the editor's build/ (9), monaco-vscode-api's build and probes (12), contrib (7), the demo
     (5), tsval's scripts and bench (5), silo's and debug-mcp's CLIs and hook, configs. Used by being run (CI, dev).
   - **New since the record** (about 8): insights' changes.ts, debug-mcp's agent audit and tool, tsval's playwright and
     vite modules, and others since 2026-11-24.
   - **Leads in the editor's realms** (about 25): almostnode's index, npm-util and four shims (domain, https,
     perf_hooks, util); capabilities' and history's engines, packages worker and TS server plugins (a realm the record
     doesn't reach: the TS server's); shell's account dialog and git-clone; shared/socket-gate (coverage leaves it out
     by name); app/tools/host; editor-api's debugger and index; playwright's and tsval's index.
   Measured by statement (2026-11-27; the user: "time to get more granular"): the record is version 3 (lib 47d3a86),
   each file's statements by start line with the tests that ran each, 1.9 MB — coverage run 45932711447's 101 browser
   tests (at b5f962cb) and 1,832 unit tests run in a throwaway editor (at 2da2da72; 159 of 189 files: 23 of the API's
   need workerd, 5 hit unenv's missing net and crypto, node-test.test crashed the tab, log.test asks exec). Of 557 code
   files with statements, 143 have none run, and 417 declarations go unrun in files that partly ran. By cluster:
   - **Can't run in the editor yet**: the API (45 files, workerd), the site and playwright's engine tests (unenv).
   - **No tests**: admin (17 files), account, bablr, eslint-plugin-webawesome's rules (its test didn't run), the theme's
     scripts.
   - **Tooling**: monaco-vscode-api's build and probes, contrib, the editor's build/, demo, bench, configs.
   - **Realms no test reaches**: the TS server's plugins (capabilities and history ts-plugin.js, the engines and
     packages worker), tsval's node-test.js, playwright and vite modules (they run inside a run), socket-gate.
   - **Needs GitHub or an account**: shell's session.ts, sign-in.tsx, github.ts, repo-load's loadRepo and fast-forward,
     git-engine's push, pull and fetch, git-clone.ts, reset.ts.
   - **Plain gaps** (a test away): bridge's capability decisions (decide.ts, 10), tsval's canary and package-calls,
     debugger session hooks (setBreakpoints, setPace, stepOut), install.ts's linking, ata's resolveImport, the margin's
     withPlace, editor-metrics' worker names; almostnode's shims (148 declarations), bablr-language-ts (41), silo (24).
   (Lines in test-runs.ts and preview-windows.tsx shifted between the two commits: those two read wrong.)
   Next (the user, 2026-11-26: "dispatch, then backfill tests, measure again, reassess"): tests for the plain gaps and
   the realms, then measure again. Backfilled (2026-11-27): a package's own calls in a run (package-calls.spec); the TS
   server's plugins counted (ee1659c5); the debugger stopped (debugger.spec), which found Step Out disabled everywhere but
   an agent's tool, the Call Stack one frame deep (fixed, 6cc7583e; a value set from the Margin broke and was mended,
   67034baf); a file: dependency linked (package-types.spec); a rule put back (mock-value.spec); ata's # imports;
   almostnode's shims against Node (shims.test), which found timingSafeEqual and exec unlike Node's (fixed, e7ec9e67);
   editor-metrics' worker names. Not tests but measurement: tsval's in-run modules (node-test.js, playwright.js,
   vite.js) run as a run's guest code, which coverage's instrumenting doesn't count; silo's test command runs in the CLI
   processes its tests spawn, which no coverage counts; bablr-language-ts's grammar.ts reads as partly run with its
   top-level constants not, so its lines don't match what ran. For the reassess: the shims nothing reaches (esbuild's
   build, chokidar, readdirp, rollup, http2, tls). Measured again (2026-11-27, at 2e50df9d: coverage run 46010188876's
   102 browser tests and 1,834 unit tests in a throwaway editor): statements run 24,068 → 24,872 of 39,700; files with
   none run 143 → 137, declarations unrun in files partly run 417 → 361; nothing newly unrun. Reassessed, the rest:
   - **Seen in the editor** (2026-11-27): History: What Nothing Ran… lists them — no test ran it, by the record; and,
     from the evidence kept, whether a run here did (the editor's own use under COVERAGE=full), and what calls it.
   - **Nothing calls it, nothing ran it, worked through** (2026-11-27): of the record's unrun declarations in files
     unchanged since 2e50df9d, one had no mention anywhere but its own: almostnode's uint8ToBinaryString (its last caller
     went in 2a2d17bc), removed. Kept with why: readdirpPromise and getPackageBase, the readdirp and rollup APIs the shims
     stand in for, which programs call. The 82 the view first showed were its blind spots, now closed: an export a
     program outside uses (its own group), and an import by a package's name the graph didn't follow
     (`@brianjenkins94/monaco-vscode-api/main`'s shownNotifications, which editor-state.ts serves): an import by name
     counts as a caller now.
   - **Ran in use, no test runs it, worked through** (2026-11-27; 10, the editor's own use under COVERAGE=full): tests
     for git-push's remote, github.ts's connectGitHub and actions, session's reportError (shell-signed-out.test) and
     observability's linkServiceWorkerHub, the preview link's announce, servePageTools and installWindowMessageProbe
     (page-links.test); repo-load's behindGitHub kept for the GitHub stand-in (it runs once a workspace is a GitHub
     repository's); tsval's CONSTRUCT_PROBE was the view's mistake — a value built from a function read as a function,
     its line's run not counted — fixed. The view reads the program afresh when asked now, and opens its list as a
     document; it reads the active file's project only (open a file of the project to ask about). Next: called and
     never run (1,218 in the editor's project, most of it what the GitHub stand-in and the API would reach).
   - **GitHub stood in** (2026-11-27), **in the editor** since page.route (the user: "Build the workarounds"):
     test/in-editor/github.spec.mjs opens an editor whose API is its own origin's /__test-api (`?api=/__test-api`, on
     localhost only: shell/session.ts) and answers it by page.route with api-stand-in.mjs — the API's sign-in and its
     proxy, and a GitHub whose repositories are kept as git keeps objects, served as git over HTTP (a clone, a fetch, a
     push) and REST. Signed in from the GitHub button: a repository loaded, cloned through the proxy; GitHub moved ahead,
     the fast-forward offered and caught up (behindGitHub, fastForward); a commit pushed back from the terminal, by
     who's signed in. It replaces test/workbench/github.mjs and sign-in.mjs (and the API harness's repositories, there
     only for them). On the way: a sign-in started in a named instance now comes back to it (shared/instance.ts reads
     the instance from the sign-in it's finishing; it came back to the default one).
   - **Measured again** (2026-11-27, at 72157b4c: CI's coverage run 46072531887 and 166 of the 168 unit test files in
     a throwaway editor — api's log.test asks for exec, debug-mcp's sessions.test runs past 5 minutes; cdp-memory-realms'
     reach kept from the last record, nothing it reaches changed): statements run 24,300 → 25,361 of 40,054; files none
     run 143 → 136 (git-clone.ts, own-evidence.ts, unrun.ts and unrun-of.ts, bablr-parses.ts, build/coverage.ts and
     stale-entries.ts); declarations unrun in files partly run 370 → 338 — repo-load's loadRepo, behindGitHub and
     fastForward, git-engine's fetchBranch, pull and push, session's account and status among them. bablr-worker's
     reidentify runs in no test (it changed in 9068bf07).
     What Nothing Ran… on it: called and never run 1,218 → 1,200, most of them what the record doesn't measure rather
     than what no test runs — packages/api 423 (its tests run in workerd, outside the record), components 111 (the
     monaco-vscode-api component isn't instrumented), packages/admin 95 (admin.mjs records no reach), and scripts and
     benches run by hand. Next: those into the record, then what's left is what no test runs.
   - **What wasn't measured, measured** (2026-11-27, a7d2b507; the user: "Item 3's measurement"): the API's 23 test
     files that run the Worker in workerd record each test's reach (packages/api/test/worker.ts: the Worker built from an
     instrumented copy of src/, asked for its counts after each test; a dispatched architecture run's `api-reach` job),
     admin.mjs records the admin app's (its vite.config.ts counts it), and the monaco-vscode-api component is built
     counted in a dispatched run. The record remade at a7d2b507 (coverage run 46101380320, all green; 166 of the 169 unit
     test files in a throwaway editor — log.test asks for exec, sessions.test ran past 5 minutes, playwright's route.test
     can't load there, as it launches Chromium through playwright-core and unenv has no `net` — and cdp-memory-realms'
     kept, nothing it reaches changed): 2,135 tests; statements run 25,361 → 28,629 of 40,287; files none run 136 → 75;
     declarations unrun in files partly run 338 → 352, the newly measured files' own. The API 136 → 2,121 of 2,794
     statements (files none run 45 → 11: its local harness, the sign-in pages' scripts in public/, scripts); the admin
     app 0 → 213 of 525 (17 → 3: deployment.ts, timeline.tsx, its vite config) and account 0 → 61 of 221; the component
     0 → 892 of 1,070 (12 → 1: its vite config). playwright's route.ts reads 64 of 95 run, by the specs (page-route,
     github). Found measuring: what a driven editor ran in a page the spec then navigates away from is lost —
     github.spec leaves for the sign-in's start page and reloads, so shell/git-clone.ts (none run, 30 statements) and
     repo-load's loadRepo, which it runs (its clone asks the stand-in's upload-pack), read as unrun; the coverage
     runtime published a realm's counts only when the editor let its window go, not when the page itself went. Fixed
     (2026-11-27, the user: "Yes, fix it"): a window's realm publishes them as its page goes (pagehide), which the
     harness keeps for the next read, as it keeps the debug worker's; github.spec alone, counted: git-clone.ts 0 → 30
     statements, repo-load.tsx 42 → 73. A worker that goes with its page still isn't counted (it has no pagehide). The
     record has it from the next dispatched run. Left,
     the 75: tooling and configs, scripts and benches run by hand, tsval's in-run modules and silo's and debug-mcp's
     CLI processes (Kept, as measurement); the API's public/ scripts, run on the API's origin, which nothing counts;
     eslint-plugin-webawesome's rules (its test can't find `uri-js` in the editor); admin's timeline.tsx and
     deployment.ts; git-clone.ts (above); account-dialog.tsx; almostnode's domain and perf_hooks shims; bablr's
     shims/record.js; site's gate.ts.
   - **Removed**: zenfs-vfs's getSharedWorkspaceBuffer and mountWorkspaceVfs (nothing calls them since the node worker
     went, 517144b7).
   - **Kept, as measurement**: tooling used by being run (the editor's build/, contrib, the demo, bench, monaco's build,
     tsval's scripts, configs); silo's CLI in the processes its tests spawn; tsval's in-run modules; bablr-language-ts's
     grammar.ts (its lines don't match what ran). The API in workerd and monaco's probes are measured since a7d2b507.
   - **A test away** (callers, no test): the eslint extension's globOf and projectFolderOf, ci-status's icons, the
     Features view's slower badge, the terminal's tab completion (longestCommonPrefix), test-notice's digestOf, the
     Changes panel's plain rows and collapse, codehike's fold slot, the playground's instance, the reset popover's loss,
     the explorer's orderings' ordinals and a crash's place, a debugger stop's odd values (asString) and breakpoint
     hook, a replayed capability's word, nothing to run's message, failureText, the app tools' sessionOf/previews/runs.
   - **Needs GitHub or an account**: session.ts, sign-in.tsx, github.ts, repo-load's load and fast-forward,
     git-engine's push, pull and fetch, git-clone.ts, reset.ts. Open: a test double for GitHub and the account API, or
     these stay what CI can't reach.
   - **No tests**: admin's timeline.tsx and deployment.ts (admin.mjs runs the rest of it, and account, since a7d2b507).
     Open: tests, or a decision they stay manual.
   - **almostnode's shims nothing reaches** (130 declarations: esbuild's build, chokidar, readdirp, rollup, http2, tls,
     brotli, dns). Open: kept for the programs that may call them, or out until one does.
   - Found measuring: under coverage, a run right after "Put the rule back here" went without the rule (mock-value.spec,
     CI's instrumented run 46010188876; here once in a full run). The cause was the spec's: typing the file under load
     made one more line, so its three ArrowUps put the rule on line 2, after `rate` is read (the Margin said rate = 5,
     total = 30); it goes to the first line with PageUp and Home now (2026-11-27). Two silent ways to lose a rule found
     on the way, made right: the policy's cache keyed a file by its mtime and size, which a moved place keeps the size
     of, so it's keyed by the file's text (editor-api policy.ts; policy.test rewrites it at the same size and mtime);
     and a place a run couldn't resolve (BABLR unparsable or unavailable) dropped the rule without a word, so it's
     asked three times and then the run says it goes without it (bridge placed-rules.ts).
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

- **A TextMate tokenizer error under COVERAGE=full** (2026-11-27, once): reloading an editor served with
  `COVERAGE=full` with packages/hub/src/index.ts (1,700 lines) open, the workbench's tokenizer threw "Cannot set
  null/undefined state" (reported as E-NEUF-J89K); plain, a reload with another file open didn't. Whether it's the
  instrumented realms' load or a race of VS Code's own is open.

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
