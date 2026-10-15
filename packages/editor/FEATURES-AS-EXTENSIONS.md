# Features as extensions

Each feature one folder, written the way editor-contrib's template (`contrib/`) is: against VS Code's API, editor-api
and the commands EXTENSION-POINTS.md documents — nothing else. Started 2026-10-13, after a count of `packages/editor`
(35k lines) found most features spread over three to five folders: the debugger in `extensions/tsval`, `workbench/` and
`extensions/bridge/`; git in `shell/`, `workbench/`, `shared/` and the bridge; capabilities in four. The event sheet —
one folder — is the shape the rest should have.

Moving files doesn't get there. A feature's code sits in `workbench/` or the bridge because something it needs has no
public way in; the move follows once the way in exists. So this plan is a list of **missing seams**, each named by what
it unlocks, and the order to build them in. EXTENSION-POINTS.md's test holds: a seam is real when our own code goes
through it.

## The test

A feature passes when it could ship in editor-contrib's place: its imports are `vscode`, `@brianjenkins94/editor-api`
and util; the commands it runs are VS Code's or ones EXTENSION-POINTS.md documents; its files load the way a contributed
extension's do. The rest of core — the shell's chrome, previews, the workbench's boot — isn't a VS Code augmentation and
isn't held to it.

## Where it stands (2026-10-13)

| Feature | Passes? | What it reaches that isn't public |
| --- | --- | --- |
| type-queries | yes | — |
| running | yes (since S2) | — |
| notes | yes (since S3) | — (`_types.at` is documented now: EXTENSION-POINTS 5) |
| event sheet | yes (since S1) | — (core's build makes its folder, its recognizer sharing lsp/'s TypeScript) |
| cspell | nearly | `shared/zenfs-vfs` (an in-memory one: its own copy, or almostnode's own VFS, would do) |
| history | yes, but its core half | the extension passes (S1, S2); the edit history it reads is `workbench/edit-history.ts` (zen-fs, git-engine, the classifier) |
| eslint | no | `shared/runtime-vfs`; its preset built by core's Vite plugin (virtual modules) |
| insights | yes (since S2, S3) | — |
| capabilities | no | its plugin and canary engine built by core from `shared/capabilities/`; ~780 lines of its logic in the bridge (the decider, what an answer at a stop means, rule places, `rules.*`); `workbench/rules-view.ts` (a custom view on monaco internals) |
| tsval | no | the workspace's buffer and zen-fs directly; `shared/workspace-runtime` (core's preview taps), `NETWORK_PROBES`, canary, preview-evidence; `run.policy` (undocumented); its Margin is `workbench/live-values.ts` |
| running's other half | the bridge's, by right (2026-10-14) | preview runs as `production` debug sessions, the `run` task provider, the terminal's `node` auto-attach and the run picker's tasks: each shows a core thing as VS Code's own (a debug session, a task) — the crossing, not running's logic. Live runs moved (S2) |
| Source Control view | yes (since S4) | — (`extensions/source-control`, on the `editor.git.*` commands) |
| architecture view | — | `workbench/architecture-view.ts` (2.6k with its CSS) on the raw hub; command counts from command-tap, which contributed extensions don't get |
| the Margin, recorded stops, coverage, profiles | — | `workbench/live-values.ts`, `recorded-stops.ts`, `coverage.ts`, `profile-files.ts` — fed by hub subjects only the bridge publishes |

In lines: the bridge is ~3.1k, about half of it one feature's logic; `workbench/` is ~11.9k with its CSS, about 4.1k of it
feature code that could move.

## The missing seams

**S1. The loader ships an extension's files** — done (2026-10-14): every extension, the editor's own and contributed
ones, loads from a folder — its entry and each file its manifest's `files` lists (workbench/extensions.ts) — and the
build makes each of the editor's into `extensions/<name>/` (its workers' bootstraps, its tsserver plugin with the engine
beside it, its webview's script); workbench-entry's per-extension wiring is gone. What core's build shares between
workers (lsp/'s chunks, TypeScript among them) an extension's files import from there.

*Was:* `contributed-extensions.ts` registered only a manifest's `browser` entry,
so an extension with a tsserver plugin, a worker or a webview script can't load the way contrib does — contrib inlines
its worker for that reason. Core builds and registers those files for cspell, the event sheet, history, eslint and
capabilities instead. Either the loader registers what a manifest declares (`typescriptServerPlugins`' files, extra
assets from the extension's folder), or each extension inlines everything into one file. *Unlocks:* five extensions'
packaging, the biggest group by count.

**S2. Core's libraries as packages** — done for what extensions import (2026-10-14): evidence, policy, effects,
lifecycle, cpuprofile, gated-eval, failures and a preview's reports are editor-api's (`./evidence`, `./policy`,
`./effects`, `./lifecycle`, `./cpuprofile`, `./gated-eval`, `./failures`, `./recorded`), their tests with them. Left in
`shared/`: the canary, capability-breakpoints and runtime-vfs (they bring tsval, almostnode and a runtime TypeScript —
they go with tsval's decision), tarball-url (capabilities' baseline; three lines), and what only core's realms run. The
realm lint now bans `shared/` to every extension but the bridge, capabilities, cspell, eslint and tsval.

*Was:* What extensions import from `shared/` is library code — `evidence-store`,
`cpuprofile`, `lifecycle`, `gated-eval`, `preview-evidence`, `capabilities/{canary,capability-breakpoints,silo-store,
run-effects}` — that runs wherever it's imported. It goes to editor-api (what a debugger or an extension needs of the
editor: `./recorded`, `./gate` already) or util (pure). Mechanical. (It was `run-contract` until 2026-10-14; renamed
first, so editor-contrib's imports change to the new name once.) *Unlocks:* every extension's `shared/` import.

**S3. Document what's already used, or replace it** — done (2026-10-14): EXTENSION-POINTS 5 lists every command an
extension may run, `editor.arch.commands` named as core's own.

*Was:* `_types.at` (the capabilities plugin's; notes and insights depend
on it), `editor.metrics.read` (the bridge's), `run.policy` (the bridge's; tsval's explore), `editor.arch.commands`
(command-tap's). Each becomes a documented extension point — `_types.at` named as the capabilities extension's, with
`extensionDependencies` — or goes (~~`run.policy`~~: done 2026-10-14 — tsval's explore, which runs outside a session and so has no
`__policy`, reads the policy as the capabilities extension does, through editor-api's `./policy`). *Unlocks:* notes, and insights
with S2.

**S4. Commands for the hub's services, both ways.** Only the bridge is on the hub, so a feature that answers a hub
request or calls a core service stays where the hub is. Two halves:

- *Core's services as commands* — git (`status`, `file`, `commit`; done 2026-10-14, a change seen as a file change) —
  so the Source Control view needs no hub. (Runs and previews needn't: what showed them in VS Code is the bridge's
  crossing — below.)
- *A hub subject answered by an extension's command* — a manifest declares it
  (`contributes.hubServices: [{ "subject": "rules.list", "command": "capabilities.rulesList" }]`), the bridge serves the
  subject and forwards it. `rules.*`, `margin.state`, `rules.state`, `history.chunks|texts`, `runs.ledger`, `editor.state`
  and the agents' `files.*` move out of core with it.

*Decided (2026-10-14):* running's ~525 bridge lines stay — preview runs as debug sessions, the task provider, the
terminal's auto-attach and the run picker's tasks translate core's runtime into VS Code's own run UI, which is the
bridge's job; moving them would take a channel pushing core's streams into an extension (callback commands — typed by
editor-api as annotations are, but each a new seam), for no simpler shape. *Unlocks:* the Source Control view into its
extension, the rules view into capabilities,
and the agent tools' answers into the features they're about.

**S5. The decider (EXTENSION-POINTS §7).** What a capability call or a stop's answer *means* is capabilities' — the
policy, "this run" rules, `always` overrides, the redline and grants, observations — but it's in the bridge, and the
bridge's own seams (`runtime-fs.ts`'s gate, `debug-events.ts`'s `__policy`) import it. The seam: the capabilities
extension answers `capabilities.decide(call)`, `capabilities.answer(session, ask, choice)` and
`capabilities.policyFor(session)`; core asks it, and asks nothing when it isn't there (allow, as without a policy).
*Deferred* (decided 2026-10-14): the decider stays last, as EXTENSION-POINTS orders it — when a second decider needs it.
Until then capabilities' decision logic stays in the bridge, and capabilities passes the test on everything else.
*Unlocks:* ~780 bridge lines (decide.ts, coalesce.ts, capability-stops' meanings, debug-control's rule places), and
leaves runtime-fs and debug-events as plumbing.

**S6. Run events for any extension.** A run's values, its end and a stop's question reach core only as subjects the
bridge republishes (`values.session.*`, `values.ended`, `capability.ask`, `evidence.observed`); coverage reads DAP's
custom events itself, which works only in its own host. The seam: the run contract's events as a stream any extension
subscribes to, whichever host the debugger is in. *Unlocks:* the Margin (live-values, 1.9k with its CSS) as an
extension providing the `margin` pane view, and evidence's observations.

**S7. A preview page as a runtime.** Pages report over hub-only subjects (`evidence.preview`, `stops.preview`,
`preview.profiled`, `preview.version`, `preview.stops`) with no editor-api counterpart. The seam: a page's reports as
editor-api events of its run. *Unlocks:* recorded stops, profiles and stepping a recorded stop (the bridge's
`replay.ts`) into their extensions; evidence's preview half.

**S8. Smaller, each for one feature:**

- *One pane view reading another's* — the Margin's cards read coverage's marks by a function call, and coverage calls
  `refreshView` directly instead of `editor.pane.refresh`. Coverage into the Margin as placed rules already are.
- *A rich view that isn't a webview* — the rule editor is a custom view on monaco internals; as a capabilities webview
  view it moves with the rest.
- *BABLR beyond annotations* — the cosmetic verdict and edit groups are `Bablr` function calls; as commands, the
  classifier becomes the standalone extension ARCHITECTURE.md already names as debt, and the edit history can follow.
- ~~*Command counts in core*~~ — dropped (2026-10-15): core's command service sees calls but not which extension made
  them, so command-tap (bundled extensions only) stays.

## tsval's exceptions — decide, don't assume

tsval mounts the workspace's buffer with zen-fs, which EXTENSION-POINTS.md says a contributed debugger mustn't — and also
says why tsval does: its module loading stays on the buffer because a mailbox call costs ~0.5–0.7 ms and a run's
loading makes hundreds with real packages. So tsval passing the test is a decision first: keep the buffer as a
documented editor-only privilege (`workspaceRuntime().buffer`, never a contributed one), or measure again with the
mailbox batching loads. The rest is ordinary: preview taps added core-side behind editor-api's `serve()`,
`NETWORK_PROBES` a default of `connectRuntime`, canary and preview-evidence via S2, `run.policy` via S3.

## Where each feature ends up

| Feature | Its folder | Moves in | Needs |
| --- | --- | --- | --- |
| Running | `extensions/running` | ~~bridge: live-run.ts~~ (done); its crossings — production-adapter.ts, the tasks provider, launch helpers, auto-attach — stay the bridge's | — |
| Capabilities | `extensions/capabilities` | bridge: decide.ts, coalesce.ts, stops' meanings, rule places, `rules.*`; `workbench/rules-view.ts`; `shared/capabilities` (→ S2) | S1, S2, S4, rich view; S5 (deferred) for the decision logic |
| Debugger | `extensions/tsval` (+ the Margin as an extension) | `workbench/live-values.ts`, `inputs.ts`; bridge: replay.ts | S6, S7, S4, tsval's decision |
| Git | `extensions/source-control` (the view) + core's engine | ~~bridge: source-control.ts~~ (done) | S4 |
| History | `extensions/history` | `workbench/edit-history.ts` (its store via `storageUri`) | S1, S2, BABLR commands, S4 |
| Evidence and insights | `extensions/insights` | `workbench/coverage.ts`, `profile-files.ts`, `sourcemap.ts`, `recorded-stops.ts` | S2, S3, S6, S7, one view reading another |
| Event sheet, eslint, cspell | as now | their built files into their folders | S1 |
| Architecture view | `shell/` or stays | it needs a raw hub, not the workbench's; command counts | command counts in core |

**What stays core.** `workbench/`: the boot, zen-fs and its overlays, the CDN `node_modules`, ATA, the git engine and
service, BABLR's worker, the pane views' frame, the run registry, evidence's ledger, the runner, the terminal (zen-fs
and the runner). The bridge: the uplink, the run contract's reader (debug-events, agent control in debug-control),
runtime-fs, the annotation commands, metrics and parse status, and the crossings into core's own UI (the run picker,
the debug toolbar, the task terminal, preview runs as debug sessions, the task provider, the terminal's auto-attach) —
about 2k of its 3.1k, and capabilities' decision logic (~500) until the decider.

## Order

1. **Free moves and naming** — ~~live-run.ts to running~~ (done 2026-10-14: it needed only `appRootOf`, now pure in
   `shared/lifecycle.ts` beside running's other run classification; `run.liveRuns` is running's setting); S3's commands documented or replaced; S2's libraries
   out of `shared/`, with the `editor-api` rename. Small, no design; type-queries, running and notes pass after it.
2. **S1, the loader** — cspell, the event sheet, history and eslint pass on packaging; capabilities' plugin loads like
   any extension's.
3. **S4, commands for the hub** — ~~the Source Control view~~ (done), the rules view, the agents' answers. (Running's
   bridge half stays: S4's note.)
4. ~~**S5, the decider**~~ — deferred (S5's note); capabilities' decision logic stays in the bridge until then.
5. **S6 and S7, run events and preview pages** — with the rules view and the agents' answers folded in (2026-10-14).
   S6 needs no new seam: VS Code hands every extension host each debug session's custom events
   (`onDidReceiveDebugSessionCustomEvent`), so the run contract's `values`, `ended` and `ask` are public already —
   the bridge only re-published them on the hub (debug-events.ts, unchanged). Evidence and profiles stay core's: they
   capture into `.silo/` (evidence.ts, profile-files.ts), the files being the seam insights reads. In order:
   - ~~**5a. Rule editing → capabilities.**~~ Done (2026-10-14), but not as planned: the rule *editor* stays core's. A
     webview — an extension's own view — can't paint in this workbench (the coi-serviceworker keeps one origin; a
     webview's content needs its own: tsval-debugger's WV-1), so the Rule view is core's real-DOM view
     (workbench/rule-view.ts, rule-editor.ts out of the component) and one core command edits any rule —
     `editor.rules.edit(request)`, answered with the button pressed (EXTENSION-POINTS 5). Everything else about rules
     moved to the capabilities extension: the rules and their places (rules.ts, out of the bridge), the tree's commands
     (rules-tree.ts, out of workbench/rules-view.ts). A rule's sentence and what it would do are editor-api's `./rules`,
     shared by the view and the tree. The Rules tree, the Margin's Rule… and Mock… and the bridge's preview prompt each
     ask for an edit and do what the button means; the hub's `rules.make` went. The places follow a file's edits through core's
     `editor.history.texts` (was the hub's `history.texts`). What agents ask of the rules is 5d's.
   - ~~**5b. The Margin → its own extension.**~~ Done (2026-10-15): live-values.ts (now margin.ts), inputs.ts and
     coverage.ts are `extensions/margin` (web worker host), reading the run contract's events themselves — the bridge's
     `values.session.*`, `values.ended` and `capability.ask` went. What it asked the bridge over the hub is commands
     (EXTENSION-POINTS 5): `editor.capability.decide`, `editor.debug.setValue`, `editor.debugFile`'s `cases`; a recorded
     result is editor-api's `recordedResult`; `margin.state` is its command, which the bridge answers the agents' tool
     by. A question's answered once the session tells `values` again (the contract's `ask` says so). Anchors went to
     editor-api (`./anchors`): core's pane follows a `ran` item by it too. Core keeps only the pane and its look
     (pane-views.css, was live-values.css); the Margin is a manifest's `paneViews` like any.
   - ~~**5c. Recorded stops as a run's values.**~~ Done (2026-10-15): the bridge's recorded-stops.ts tells a page's stops
     as `values` on its preview's `production` session (production-adapter.ts's `tellPreview`), each report every hit so
     far — the contract's `replace`. A preview with no production run (none today) shows none.
   - ~~**5d. The agents' answers.**~~ Done (2026-10-15): the bridge answers `margin.state` and `rules.state` (the
     `margin_state` and `rules_list` tools) by the owning extension's command, from one fixed list (bridge/answers.ts);
     the tours run the rules' commands themselves (the harness's `session.execute`), so `rules.given`, `.list` and
     `.set` left the hub.
6. ~~**tsval's decision, then its move**; the architecture view's realm; command counts in core.~~ Done (2026-10-15):
   - **tsval keeps the buffer** — a documented editor-only privilege (EXTENSION-POINTS 2): the realm lint lets it import
     shared/workspace-runtime and shared/zenfs-vfs, nothing else of `shared/`. The rest moved: the network probes to
     editor-api (`./probes`, `connectRuntime`'s default), runtime-vfs to editor-api (`./runtime-vfs`; almostnode one of
     the packages every build dedupes), tarball-url into editor-api's `./runtime`, the canary and capability-breakpoints
     (now capability-calls.ts) into extensions/tsval — the capabilities plugin's canary is built from there — and the
     preview taps into the dev-server worker, for every server. tsval, eslint and capabilities left the lint's
     still-in-shared list; only the bridge (core's) remains — cspell left too (2026-10-15): its server's in-memory
     filesystem is almostnode's own VirtualFS, not zen-fs (it never read the workspace).
   - **The architecture view stays in the workbench**: core's own diagnostic view, a VS Code tab, where the raw hub is.
   - **Command counts stay command-tap's**: core's command service can't tell which extension made a call — the view's
     point — so a contributed extension (loaded by URL: editor-contrib's) goes unattributed. S8's item dropped.

Each step ends with its features passing and nothing left behind them: a feature that moves takes its tests, and core
keeps no fallback for the old way.

## Holding the line

The realm lint (root `eslint.config.js`) already stops an extension reaching another's folder or a realm's. When a
feature passes, its extension's lint block gets one more ban — `shared/` — so it can't start reaching core again. The
measure of done is the bridge at its plumbing (~2k, ~2.5k while the decider waits) and `workbench/` at its boot.
