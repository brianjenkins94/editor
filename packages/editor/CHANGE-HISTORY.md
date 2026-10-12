# Change history, derived

Commits are a poor record of change. Too much in git and GitHub needs a commit to start (a push, CI, a deploy, a
release), so commits happen when the tooling needs one, not when something meaningful happened, and their messages
become noise. Keeping a useful history today takes discipline: small commits, careful messages, a changelog. This
design takes that discipline away. **History is derived from what the code is and what it does, never written.** It is
deterministic: fixed rules over computed facts, no model.

## What a commit does today

A commit does five jobs at once: a checkpoint to return to, transport (sync, push, share), the trigger for CI and
deploys, the unit of review, and the story of what changed and why. The mechanical jobs decide when commits happen, so
the story comes out shaped by CI.

Here commits keep only the mechanical jobs. Make them automatically, squash them, rebase them; nothing below depends on
commit ids or messages. Everything is computed from content, which survives rebase, squash and force-push
(collab-identity.test.mjs).

## The model

Three layers, each a pure function of the code's snapshots and the runs recorded against it.

**1. Spans.** Every span (a node of the parsed code) has an identity that follows it through moves and reformatting
(BABLR anchors, `reidentify`; SPAN-ANNOTATIONS.md). Its lifeline: when it appeared, each change and whether it was
cosmetic or semantic, when it moved or went away, when it first and last ran, and which tests reach it. Snapshots come
from the edit bursts the editor already captures, or from git commits, which are just coarser snapshots.

**2. Features.** A feature is a way in plus the code it reaches. A way in is something a person, an agent or another
part of the program can reach: a command, view, setting, button, terminal command, URL parameter, agent tool, hub
request or subscription, a core module. Reach is the spans its registration leads to, statically through imports and
in practice through recorded runs. A feature's lifeline follows: introduced when its way in appears, changed when a
span it reaches changes semantically, exercised when a run reaches it, removed when its way in goes.

**3. The story.** Fixed sentence templates over those facts, grouped by feature rather than by time ("Added command
*Rules: New Rule*", "Renamed setting `tsval.liveRuns` → `run.liveRuns`", "Tried the TestController coverage UI: added
Oct 1, removed Oct 3"). Edits can be grouped into attempts by rule as well: the same feature's code, the same session,
joined by edit → run → edit cycles.

**What you still say yourself**, and only if you want to:

- **A feature's status:** active, parked or stopped, one click.
- **Notes on spans**, which already exist and follow the code.

Status makes drift detectable: a feature marked stopped that still loads at boot, or one marked parked that keeps
changing. CLEANUP-AUDIT.md found exactly these by hand (the ESLint preset, the paused capability engine) by comparing
recorded decisions with the code.

## What the first replay showed

The first experiment replayed the repo's first-parent history through a feature extractor and wrote
FEATURE-TIMELINE.md: 706 commits in 12 seconds, each file version parsed once and cached by blob. It reads no commit
messages.

- **The week of Oct 5–11:** git's log is 116 commits, one subject line each. The derived week is 89 sentences, grouped
  by area, with internal hub plumbing folded into one line per area.
- **Tried and removed:** 33 groups of features that appeared and later went away. That's the history of this repo's
  experiments, which no commit message lists: the Preflight extension (Sep 10–12), comment annotations (Sep 16–17), the
  TestController coverage UI (Oct 1–3), the running status bar (Oct 2–3), Run with Inputs (Oct 5–6).
- **Moves are moves.** Features are keyed by what they are, not where they live, so the `packages/vscode` →
  `packages/editor` rename reads as "Moved 111 features", and a same-commit removal and addition with the same label
  reads as a rename.

Limits, by design of a first cut:

- **"Changed" is file-level and token-level,** not span-level. A feature counts as changed when its registration (with
  its inline handler) or the module a core `install*` comes from changes in tokens. The real version is spans (layer 1).
- **No reach yet.** 457 of the 706 commits change code that no registration contains directly. Reach (layer 2) is what
  places them.
- **No runs yet,** so nothing is "exercised" or "dormant".
- **The ways in are this repo's:** VS Code extension APIs, the hub, MCP tools, shell buttons. Another repo has others:
  routes, CLI commands, a library's exports. Recognizing ways in should be pluggable.
- **Unnamed providers** (`registerHoverProvider` with only a selector) get keyed by file.

## Building it

In order, each useful on its own:

1. **Reach.** Each feature's static reach from its registration (the import graph, then the call graph), plus the spans
   recorded runs reached. "Changed" becomes "a span it reaches changed".
2. **Spans in place of tokens.** Span identity and the cosmetic verdict from BABLR in place of the token compare.
3. **Live, not only from commits.** Derive from edit bursts as you work. Keep the derived facts in `.silo/`, and the
   bursts only as long as they're needed (today edit-history.ts drops them at each commit).
4. **Runs.** Exercised and dormant from the run ledger and coverage (RUNTIME-EVIDENCE.md).
5. **Status and drift.** The one-click status per feature, kept in `.silo/`, and the drift checks it enables.
6. **In the editor.** A history view by feature in place of the commit list; the changes pane groups by feature.
7. **Commits as transport.** Optionally, the derived sentences as the message of whatever commit the tooling needs.

## Where it lives

- **The logic** is in lib's `util/silo`, pure and browser-portable on oxc: `features.ts` (the ways in, the features they
  make), `history.ts` (the replay, the events, the sentences), and `git-snapshots.ts` (a git history as snapshots, the
  Node one).
- **The command line** is `packages/silo` in this repo, published from here as `@brianjenkins94/silo` (bin `silo`):
  `silo features [repo]` and `silo history [repo] [--since …] [--until …]`, each with `--json`. It runs in any desktop
  terminal, VS Code's included.
- **The editor** uses the same internals. In the browser, snapshots come from the editor's own git (isomorphic-git) and
  edit bursts instead of `git cat-file`.

## Open questions

- **Names.** Code names a feature by its id (`installLiveValues`); people call it "live values". Labels from manifests
  help; docs and notes could supply the rest.
- **What counts as one feature.** A command and the view it lives in; a hub request and the command that calls it.
  Reach may answer this: features with the same reach are probably one.
- **Prior art to learn from:** Jujutsu (a change keeps its id across rewrites), Unison (history per definition),
  Smalltalk's changes log and ENVY (every change recorded, no discipline), xit (content-addressed line identity).
