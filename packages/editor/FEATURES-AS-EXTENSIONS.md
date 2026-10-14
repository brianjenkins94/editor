# Features as extensions

Each feature one folder, written the way editor-contrib's template (`contrib/`) is: against VS Code's API, run-contract
and the commands EXTENSION-POINTS.md documents — nothing else. Started 2026-10-13, after a count of `packages/editor`
(35k lines) found most features spread over three to five folders: the debugger in `extensions/tsval`, `workbench/` and
`extensions/bridge/`; git in `shell/`, `workbench/`, `shared/` and the bridge; capabilities in four. The event sheet —
one folder — is the shape the rest should have.

Moving files doesn't get there. A feature's code sits in `workbench/` or the bridge because something it needs has no
public way in; the move follows once the way in exists. So this plan is a list of **missing seams**, each named by what
it unlocks, and the order to build them in. EXTENSION-POINTS.md's test holds: a seam is real when our own code goes
through it.

## The test

A feature passes when it could ship in editor-contrib's place: its imports are `vscode`, `@brianjenkins94/run-contract`
and util; the commands it runs are VS Code's or ones EXTENSION-POINTS.md documents; its files load the way a contributed
extension's do. The rest of core — the shell's chrome, previews, the workbench's boot — isn't a VS Code augmentation and
isn't held to it.

## Where it stands (2026-10-13)

| Feature | Passes? | What it reaches that isn't public |
| --- | --- | --- |
| type-queries | yes | — |
| running | yes, in substance | `shared/lifecycle` (pure functions) |
| notes | nearly | `_types.at`, a tsserver request the capabilities plugin serves, undocumented |
| event sheet | packaging only | core builds and registers its `view.js` and recognizer worker (the editor's TypeScript chunk) |
| cspell | packaging only | core builds its worker, server bundle and dictionary; `shared/zenfs-vfs` (in-memory) |
| history | packaging | its tsserver plugin built and served by core, its `node_modules` faked by workbench-entry; `shared/evidence-store`; the edit history itself is `workbench/edit-history.ts` (zen-fs, git-engine, the classifier) |
| eslint | packaging | as history, plus the preset built by core's Vite plugin; `shared/gated-eval` |
| insights | no | `editor.metrics.read` (the bridge's, from the hub, undocumented); `_types.at`; `shared/evidence-store`, `cpuprofile` |
| capabilities | no | its plugin and canary engine built by core from `shared/capabilities/`; ~780 lines of its logic in the bridge (the decider, what an answer at a stop means, rule places, `rules.*`); `workbench/rules-view.ts` (a custom view on monaco internals) |
| tsval | no | the workspace's buffer and zen-fs directly; `shared/workspace-runtime` (core's preview taps), `NETWORK_PROBES`, canary, preview-evidence; `run.policy` (undocumented); its Margin is `workbench/live-values.ts` |
| running's other half | — | ~525 bridge lines: preview runs as `production` sessions, tasks, the terminal's `node` auto-attach, live runs |
| git's Source Control view | — | the bridge's `source-control.ts` over `git.*` hub subjects |
| architecture view | — | `workbench/architecture-view.ts` (2.6k with its CSS) on the raw hub; command counts from command-tap, which contributed extensions don't get |
| the Margin, recorded stops, coverage, profiles | — | `workbench/live-values.ts`, `recorded-stops.ts`, `coverage.ts`, `profile-files.ts` — fed by hub subjects only the bridge publishes |

In lines: the bridge is ~3.1k, about half of it one feature's logic; `workbench/` is ~11.9k with its CSS, about 4.1k of it
feature code that could move.

## The missing seams

**S1. The loader ships an extension's files.** `contributed-extensions.ts` registers only a manifest's `browser` entry,
so an extension with a tsserver plugin, a worker or a webview script can't load the way contrib does — contrib inlines
its worker for that reason. Core builds and registers those files for cspell, the event sheet, history, eslint and
capabilities instead. Either the loader registers what a manifest declares (`typescriptServerPlugins`' files, extra
assets from the extension's folder), or each extension inlines everything into one file. *Unlocks:* five extensions'
packaging, the biggest group by count.

**S2. Core's libraries as packages.** What extensions import from `shared/` is library code — `evidence-store`,
`cpuprofile`, `lifecycle`, `gated-eval`, `preview-evidence`, `capabilities/{canary,capability-breakpoints,silo-store,
run-effects}` — that runs wherever it's imported. It goes to run-contract (what a debugger or an extension needs of the
editor: `./recorded`, `./gate` already) or util (pure). Mechanical — but run-contract is due to be renamed `editor-api`
(EXTENSION-POINTS' Order, 6), and both change editor-contrib's imports: do this with the rename, not before it, so the
template's imports change once. *Unlocks:* every extension's `shared/` import.

**S3. Document what's already used, or replace it.** `_types.at` (the capabilities plugin's; notes and insights depend
on it), `editor.metrics.read` (the bridge's), `run.policy` (the bridge's; tsval's explore), `editor.arch.commands`
(command-tap's). Each becomes a documented extension point — `_types.at` named as the capabilities extension's, with
`extensionDependencies` — or goes (`run.policy` → `__policy` in the launch configuration). *Unlocks:* notes, and insights
with S2.

**S4. Commands for the hub's services, both ways.** Only the bridge is on the hub, so a feature that answers a hub
request or calls a core service stays where the hub is. Two halves:

- *Core's services as commands* — git (`status`, `file`, `commit`, `changed` as an event), runs (`list`, `stop`),
  previews (`open`) — so the Source Control view, the run picker's tasks and preview runs need no hub.
- *A hub subject answered by an extension's command* — a manifest declares it
  (`contributes.hubServices: [{ "subject": "rules.list", "command": "capabilities.rulesList" }]`), the bridge serves the
  subject and forwards it. `rules.*`, `margin.state`, `rules.state`, `history.chunks|texts`, `runs.ledger`, `editor.state`
  and the agents' `files.*` move out of core with it.

*Unlocks:* the Source Control view and ~525 lines of running into their extensions, the rules view into capabilities,
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
`preview.profiled`, `preview.version`, `preview.stops`) with no run-contract counterpart. The seam: a page's reports as
run-contract events of its run. *Unlocks:* recorded stops, profiles and stepping a recorded stop (the bridge's
`replay.ts`) into their extensions; evidence's preview half.

**S8. Smaller, each for one feature:**

- *One pane view reading another's* — the Margin's cards read coverage's marks by a function call, and coverage calls
  `refreshView` directly instead of `editor.pane.refresh`. Coverage into the Margin as placed rules already are.
- *A rich view that isn't a webview* — the rule editor is a custom view on monaco internals; as a capabilities webview
  view it moves with the rest.
- *BABLR beyond annotations* — the cosmetic verdict and edit groups are `Bablr` function calls; as commands, the
  classifier becomes the standalone extension ARCHITECTURE.md already names as debt, and the edit history can follow.
- *Command counts in core* — command-tap wraps each built-in extension's `vscode`; counting in core's command service
  covers contributed extensions too.

## tsval's exceptions — decide, don't assume

tsval mounts the workspace's buffer with zen-fs, which EXTENSION-POINTS.md says a contributed debugger mustn't — and also
says why tsval does: its module loading stays on the buffer because a mailbox call costs ~0.5–0.7 ms and a run's
loading makes hundreds with real packages. So tsval passing the test is a decision first: keep the buffer as a
documented editor-only privilege (`workspaceRuntime().buffer`, never a contributed one), or measure again with the
mailbox batching loads. The rest is ordinary: preview taps added core-side behind run-contract's `serve()`,
`NETWORK_PROBES` a default of `connectRuntime`, canary and preview-evidence via S2, `run.policy` via S3.

## Where each feature ends up

| Feature | Its folder | Moves in | Needs |
| --- | --- | --- | --- |
| Running | `extensions/running` | bridge: live-run.ts, production-adapter.ts, tasks provider, launch helpers, auto-attach | S2, S4 (live-run.ts needs nothing) |
| Capabilities | `extensions/capabilities` | bridge: decide.ts, coalesce.ts, stops' meanings, rule places, `rules.*`; `workbench/rules-view.ts`; `shared/capabilities` (→ S2) | S1, S2, S4, rich view; S5 (deferred) for the decision logic |
| Debugger | `extensions/tsval` (+ the Margin as an extension) | `workbench/live-values.ts`, `inputs.ts`; bridge: replay.ts | S6, S7, S4, tsval's decision |
| Git | `extensions/git-scm` (the view) + core's engine | bridge: source-control.ts | S4 |
| History | `extensions/history` | `workbench/edit-history.ts` (its store via `storageUri`) | S1, S2, BABLR commands, S4 |
| Evidence and insights | `extensions/insights` | `workbench/coverage.ts`, `profile-files.ts`, `sourcemap.ts`, `recorded-stops.ts` | S2, S3, S6, S7, one view reading another |
| Event sheet, eslint, cspell | as now | their built files into their folders | S1 |
| Architecture view | `shell/` or stays | it needs a raw hub, not the workbench's; command counts | command counts in core |

**What stays core.** `workbench/`: the boot, zen-fs and its overlays, the CDN `node_modules`, ATA, the git engine and
service, BABLR's worker, the pane views' frame, the run registry, evidence's ledger, the runner, the terminal (zen-fs
and the runner). The bridge: the uplink, the run contract's reader (debug-events, agent control in debug-control),
runtime-fs, the annotation commands, metrics and parse status, and the crossings into core's own UI (the run picker,
the debug toolbar, the task terminal) — about 1.5k of its 3.1k, and capabilities' decision logic (~500) until the
decider.

## Order

1. **Free moves and naming** — live-run.ts to running (no seam); S3's commands documented or replaced; S2's libraries
   out of `shared/`, with the `editor-api` rename. Small, no design; type-queries, running and notes pass after it.
2. **S1, the loader** — cspell, the event sheet, history and eslint pass on packaging; capabilities' plugin loads like
   any extension's.
3. **S4, commands for the hub** — the Source Control view, running's bridge half, the rules view, the agents' answers.
4. ~~**S5, the decider**~~ — deferred (S5's note); capabilities' decision logic stays in the bridge until then.
5. **S6 and S7, run events and preview pages** — the Margin, recorded stops, coverage, profiles and evidence move into
   extensions.
6. **tsval's decision, then its move**; the architecture view's realm; command counts in core.

Each step ends with its features passing and nothing left behind them: a feature that moves takes its tests, and core
keeps no fallback for the old way.

## Holding the line

The realm lint (root `eslint.config.js`) already stops an extension reaching another's folder or a realm's. When a
feature passes, its extension's lint block gets one more ban — `shared/` — so it can't start reaching core again. The
measure of done is the bridge at its plumbing (~1.5k, ~2k while the decider waits) and `workbench/` at its boot.
