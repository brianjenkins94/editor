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
  places them. (Built since: see *Reach*, below.)
- **No runs yet,** so nothing is "exercised" or "dormant".
- **The ways in are this repo's:** VS Code extension APIs, the hub, MCP tools, shell buttons. Another repo has others:
  routes, CLI commands, a library's exports. Recognizing ways in should be pluggable.
- **Unnamed providers** (`registerHoverProvider` with only a selector) get keyed by file.

## Reach (built)

A feature is now what it reaches: lib's `util/silo/graph.ts` is the program's declaration graph, and a change anywhere a
feature's code leads is a change to it.

- **Declarations, not files.** A node is a top-level declaration (a function, a class, a variable, an enum), an import,
  or a module's body. A declaration's edges are the names its code uses; an import's is what it resolves to: a relative
  module, or one of the program's own packages by name (through package.json `exports`), through re-exports and
  namespace imports. Each declaration carries its AST fingerprint, so formatting isn't a change. A whole-file import
  graph would make every command registered in an `extension.ts` reach the whole extension.
- **A feature's roots** are the names its registration uses. A local of the function it's registered in
  (`const runner = makeRunner(); registerCommand("x", () => runner.go())`) counts as what it's made from.
- **A module's body runs when it's imported,** and runs what it imports, so a registry filled as its modules load (tsval's
  handlers) is reached. A program's entry, which nothing imports (`main.tsx`), isn't: its boot isn't one feature's.
- **Two more ways in** that reach needed: a worker's top-level message listener (workers start from a URL, so nothing
  imports them), and hub names made at run time (``serve(hub, `virtual.debug.${port}`, …)``), keyed by how they're
  written.
- **Walking back, not forward.** Each snapshot finds the declarations that changed (not ones that only moved: the same
  name and code was somewhere before) and walks the graph backwards to the features that reach them. The event says
  which declaration: `changed … via reach (file#name)`.
- **A shared change is told once.** A declaration whose change reaches five or more features in one snapshot is told as
  its own ("Changed `createArchReporter`, which 26 features use"), not as a change to each of them.

On this repo, Oct 5–11: commits with nothing to say went from 62 to 42 of 117, and 22 of those 42 touch no code (docs,
tests). Over the whole history, from 457 to 335 of ~720, in 24 seconds. Of today's 3,326 declarations, 1,525 are
reached by some feature. What's left unreached is mostly the boot (workbench-entry), the architecture model's tables, the
vendored monaco component and the contrib template (separate programs), and build configs.

Still to do for reach: the run side (the spans recorded runs reached, step 4), and a call graph inside a declaration
(today using any name in a function is reaching all of it).

## Analysis on TypeScript 7 (built)

Reading code is a compiler's job, so the analysis moves from oxc to TypeScript 7, behind one seam (lib `graph.ts`): a
`DeclarationGraph` is what reach and history need of a program (each declaration's fingerprint, and where each node
leads), and an `Analyzer` turns a snapshot's files into one. `typescript.ts` is TypeScript's, in Node. (Since
2026-10-14 oxc is gone: `silo` bundles TypeScript 7.1 and always reads with it, and the browser reads with its
TypeScript server's.)

- **One compiler for a whole replay.** The first snapshot is a synthetic program over the snapshot's sources, given as a
  filesystem layer over the disk (which still serves `node_modules`); each later snapshot is an update with a layer of
  what changed. Nothing is checked out. (A layer alone doesn't reach a file the program already read: the program is
  reconfigured with each update.)
- **What a name is, the checker says.** Imports through re-exports and the tsconfig's `paths`, scopes, method calls:
  what oxc's name matching approximated. The program's own packages resolve to their sources, not to an installed
  copy; imports stay nodes, so the module bodies importing runs are reached, as before.
- **TypeScript 7.1** (`typescript/sync`, stable from 7.1): the one `silo` bundles, whatever the repository has (it
  used to need the repository's own, else fell back to oxc).

On this repo's whole history, TypeScript finds 2,362 feature changes to oxc's 2,081, 7 of oxc's not among them, and 331
silent commits to 336, in 66 seconds to 25. The extra come from what oxc doesn't follow (the tsconfig's paths into the
vendored monaco component and BABLR's sources). The 7 are methods reached through an object typed by an interface: the
checker resolves such a call to the interface's member, not the object that implements it, and the API has no "find
implementations". In the browser, the editor's own TypeScript server reads the code (the next section), so the editor
loads no oxc at all; only TypeScript 7's API host waits for a browser build (the unreleased Playground v2 runs a
`tsc.wasm` in a worker). BABLR isn't an analyzer: it joins history at the edge, in step 4, for data anchored by it.

## Live from edits (built)

History no longer waits for a commit. As you edit, the editor reads the program when you pause and replays it against
the last reading, and tells what each pause changed in its History output channel.

**Nothing derived from edits is kept** (decided 2026-10-12): it's for the session. Once you commit, the commit tells what
changed, and what runs say is recomputed from the runtime evidence, which is kept. What that gives up: tries undone
before any commit leave no trace (tries that reach a commit still show as tried). A first version kept each pause's
changes as facts in `.silo/history/<user>.jsonl` and told them with the commits; it was taken out.

- **Read where TypeScript already is.** `extensions/history` contributes its own TypeScript server plugin, which reads the
  program the in-browser TypeScript server already holds, unsaved edits included, with the server's own TypeScript
  (lib `ts-analysis.ts`, through the in-process host). Its engine is built without TypeScript or oxc. The extension
  asks it `_history.read` through `typescript.tsserverRequest`, gets the readings that changed, replays (lib
  `Replayer`), and tells what changed. Public API only: no hub, no capture of its own, nothing written.
- **One reading for both hosts.** Ways in and the declaration graph are read once over TypeScript's tree, behind a
  small host interface: TypeScript 7's API for the command line, the in-process API for the editor. Both find the
  same 289 features on this repo as oxc's recognizers did. (oxc has since been removed.)
Verified in the editor: adding a command registration and taking it out again, unsaved, was told as `added` then
`removed`; editing only a helper in another file was told as `changed … via reach` through it.

## What runs say (built)

A feature's lifeline now includes whether its code runs. **Exercised**: a statement of its own code ran (how many runs,
when last). **Dormant**: its file ran, its code never did. **Unobserved**: no run ran its file yet. The history extension
tells a summary when it starts, then each change (lib's narration has the sentences for them too: "Ran command `x` (…)",
"Dormant: command `y`: its file ran, its code didn't").

- **Its own code, not what it reaches.** A feature's code is its registration (with its inline handler) and the
  declarations that registration names. What it reaches further doesn't count: a helper many features share would make
  them all look exercised. Nor does the statement that registers it, which runs whether or not the feature is used:
  only code strictly inside counts. A registering call's own code is what follows its name (the handler, the provider),
  never the API that registers it (`registerCommand`, `serve`, a local `defineCommand`), which runs for every
  registration. That also keeps a change to `serve` from counting as a change to every hub request.
- **The BABLR join is at the edge.** Runtime evidence is keyed on BABLR spans. The editor's resolver places them in the
  current text (the shared evidence store, insights'), and lib's `exercise.ts` compares ranges: those placed spans
  against the feature ranges the TypeScript reading reports. Analysis never touches BABLR.
- **When.** The history extension joins after each reading, and whenever a run leaves evidence. "Its file ran" also
  counts the run ledger's envelopes (`.silo/runs/`), which list every file a run ran.

Verified in the editor: a program whose local `defineCommand` calls one of the two handlers it's given, run once under
the debugger, left `exercised` for that one and `dormant` for the other.

## Building it

In order, each useful on its own:

1. **Reach** (static: built, above). Each feature's static reach from its registration, plus the spans recorded runs
   reached. "Changed" becomes "a span it reaches changed".
2. **Analysis on TypeScript 7** (built, above). In place of "BABLR spans in place of tokens", which mixed up analysis
   with placement: the declaration fingerprints already ignore formatting, and BABLR's anchors are for keeping data on
   code (step 4's join), not for reading it.
3. **Live, not only from commits** (built, above). Derive from edits as you work, for the session.
4. **Runs** (built, above). Exercised and dormant from the run ledger and coverage, joined through BABLR's spans.
5. **Status and drift.** The one-click status per feature, kept in `.silo/`, and the drift checks it enables.
6. **In the editor.** A history view by feature in place of the commit list; the changes pane groups by feature.
7. **Commits as transport.** Optionally, the derived sentences as the message of whatever commit the tooling needs.

## Where it lives

- **The logic** is in lib's `util/silo`: `features.ts` (the feature model), `graph.ts` (the declaration graph's seam and
  reach), `history.ts` (the replay, the events, the sentences), `exercise.ts` (what runs say of a feature),
  `ts-analysis.ts` (the reading over TypeScript's tree, for either host), and the Node ones:
  `typescript.ts` (TypeScript 7's host) and `git-snapshots.ts` (a git history as snapshots).
- **The command line** is `packages/silo` in this repo, published from here as `@brianjenkins94/silo` (bin `silo`):
  `silo features [repo]` and `silo history [repo] [--since …] [--until …]`, each with
  `--json`. It runs in any desktop terminal, VS Code's included.
- **The editor** uses the same internals: `extensions/history` and its TypeScript server plugin derive history live, with
  the TypeScript server's own TypeScript.

## Open questions

- **Ways in beyond this repo.** A feature is a way in matched against a hand-written list of shapes (`features.ts`),
  and the list is this repo's: VS Code's APIs, the hub, MCP tools, buttons. That's fine here, but most repos would match
  little of it, and a shape it doesn't know reads as a removal: the terminal commands that moved to `command.ts` files
  (`export default { name, … }`) show as "tried and removed". Three layers would carry it further, in this order:
  1. **What every package declares.** `package.json`'s `exports` (its public API), `bin` (its command lines) and
     `scripts` are ways in on any JS/TS repo, with no list: each is a feature, and reach follows from it. For a library,
     that's arguably what a feature is.
  2. **Presets, switched on by dependencies.** `vscode` → today's VS Code shapes; `@modelcontextprotocol/sdk` → MCP
     tools; `express`/`fastify`/`hono` → routes; `commander`/`yargs`/`cmd-ts` → CLI commands; `react-router` → routes.
     Today's list becomes the VS Code, hub and MCP presets.
  3. **A repo's own shapes, declared, not coded.** The call and which argument is the name, e.g.
     `{ "facet": "hub request", "call": "serve", "name": 1 }`; most of today's list fits that form, and this repo's
     `command.ts` gap is one more entry.

  Until then, the feature layer is the weakest part: everything above it (reach, the story, what runs say) is per
  feature, and inherits its gaps. Parked here (2026-10-12), not built.
- **Names.** Code names a feature by its id (`installLiveValues`); people call it "live values". Labels from manifests
  help; docs and notes could supply the rest.
- **What counts as one feature.** A command and the view it lives in; a hub request and the command that calls it.
  Reach may answer this: features with the same reach are probably one.
- **Prior art to learn from:** Jujutsu (a change keeps its id across rewrites), Unison (history per definition),
  Smalltalk's changes log and ENVY (every change recorded, no discipline), xit (content-addressed line identity).
