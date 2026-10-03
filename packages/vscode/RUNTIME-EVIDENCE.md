# Runtime evidence

The editor learns what your program actually does by running it: which code ran and how often, where the time went,
the values that passed through, whether the types held, which branches were taken, which capabilities it used. It keeps
that evidence in git beside the code, attached to stable spans rather than lines, and turns it into help you can act on.

```ts
world.onWin?.();
```

> Across the last 41 runs on two machines, `world.onWin` was a function every time it was reached (1,206 times), never
> `undefined`. **Quick fix: remove the `?.`**

Coverage and profiling are the first two kinds of evidence, and both already work in a limited form. This lays out the
model they and everything after them share, where it lives, how it surfaces, and the decisions that shape it (at the end).

## What exists today

Three kinds of evidence are captured, each with its own store and its own idea of what a run is. None of them survives
in git.

| Evidence | Captured by | Stored | Keyed by | Shown |
|---|---|---|---|---|
| Coverage | tsval `coverage: true` (statement hit counts); the debug adapter's `coverage` event | An in-memory map in the insights extension; gone on reload | File path and statement range | Gutter bars and hover counts |
| CPU profiles | The shell profiles a preview that keeps running slow | `.silo/profiles/<port>-<time>.cpuprofile`, source-mapped | Port and time; tied to no run | A notification, then a hotspot picker |
| Capabilities | almostnode shims and the preview's gated fetches, via `decide` | `.silo/<user>.runs.jsonl` (one line per run) and a day-coarsened rollup | Entry file and its whole-file sha | The capabilities panel |

- **Four run identities.** The core registry's `run-N` (terminal `node` and `vite`, last 10 in memory), the runner's
  UUID (`node.start`, `debug.launch`), the VS Code debug session, and a preview's port.
- **`.silo/` is excluded from git** (`git-engine.ts` writes it into `.git/info/exclude`), and silo's own run ledger was
  designed as local, per-clone trust. Committing evidence reverses both.
- **tsval sees values only at host calls.** `beforeCall` is how the capability canary resolves real arguments.
  Observing values at `?.`, `??`, branches and bindings needs a new hook.
- **The identity spine exists.** `spanAnchors` (bablr-language-ts) gives every CST span a content-addressed,
  move-stable id. The adopted annotation model also has `reidentify(baseline → current)`. They differ, and evidence
  needs one canonical key (D1).

## The model

A run is evidence about one version of the code in one environment. Each run has an envelope that says whose, where
and what, and produces observations, each attached to a span.

**The run envelope**

- **Run**: one id from start to end, the core registry's, carried by the runner, the debug session and the preview.
- **Who**: the user, as git knows them.
- **Where**: an environment class (runtime: tsval, almostnode, preview in Chromium 140; OS family; cores; memory bucket)
  plus a machine name you choose.
- **What**: the commit, plus the blob sha of each file the run touched, so a run on uncommitted code is pinned exactly.
- **Outcome**: target, entry, mode, started, ended, exit code.

**An observation** is a kind, a span, and a summary that stays the same size however many runs feed it:

```json
{ "span": "9f3a…c2", "file": "src/world.ts", "kind": "value", "node": "OptionalCall",
  "seen": 1206, "nullish": 0, "types": { "function": 1206 }, "w": 38.4, "lastRun": 41 }
```

**Kinds of evidence**

| Kind | What it records | Source |
|---|---|---|
| `reached` | How often a statement ran | tsval coverage, today |
| `time` | Self and total time of a function | Preview profiles, today; mapped to spans |
| `capability` | Which scope a call site exercised, allowed or denied | `decide`, today; mapped to call sites |
| `value` | What passed through: type tags, nullish count, a few distinct primitives | Needs a tsval observe hook |
| `type` | Declared type against the observed values | tsval's typed call sites plus the hook |
| `branch` | How often each arm of an `if`, ternary, `&&`, `\|\|`, `??` was taken | Needs the hook |
| `error` | Throws and rejections at a span | Logs already carry them; not yet anchored |

New kinds are new rows with the same envelope and the same span key. Nothing about the store changes when one is added.

## Recency

The code changes constantly, so evidence has to fade. Two mechanisms do most of the work, and one is free.

- **Editing a span gives it a new id.** A span's id is a hash of its node type and its content, ignoring whitespace and
  comments. Edit a statement and its evidence no longer attaches; the statements you didn't touch keep theirs. The
  catch is that every enclosing span changes too: edit one line and its function's id changes, so the function's
  profile would start over unless history is carried across (D1, D2).
- **Each run weighs less as newer runs arrive.** Every counter is stored decayed: on each run of its target,
  `w = w × 2^(−1/H) + new`, with a half-life `H` in runs. It's one multiply per update, the summary stays a fixed size
  forever, and no raw history is needed to know what recent runs said.

A suggestion that edits your code needs a strict claim, not just a weighted one: "remove the `?.`" fires only if the
span was reached in enough recent runs and was never nullish since the span last changed. The decayed weight decides
how confident the hover sounds; the strict count decides whether a quick fix appears.

## Storage in git

Evidence is committed beside the code, so it travels with the repo, shows in review and survives a fresh clone. That
means designing for merges and for size.

```
.silo/
  policy.json                      decisions · shared      (as today)
  <user>.policy.json               decisions · mine        (as today)
  capabilities.json                facts · static          (as today)
  <user>.capabilities.json         facts · observed rollup (as today)
  runs/<user>.jsonl                one envelope per run · append-only · merge=union
  evidence/<user>/<env>/<path>.jsonl
                                   one line per (span, kind) · sorted · merge=union
  .gitattributes                   *.jsonl merge=union
  local/                           raw profiles, full per-run detail · gitignored
```

- **Conflict-free by partition.** Each user and environment writes only its own files, so two people never touch the
  same lines.
- **Branch merges by line.** One user on two branches does touch the same files. With one sorted line per span, git's
  built-in `merge=union` keeps both sides without any setup, and the reader folds duplicate lines for a span (largest
  `lastRun` wins, counts combine). isomorphic-git can apply the same rule as a merge driver.
- **Bounded size.** Decayed summaries don't grow with run count. Only spans that produced evidence get a line: about
  150 statements for a 300-line file, roughly 6 KB of coverage per environment. Raw `.cpuprofile`s (megabytes) stay
  local; their hotspots fold into `time` lines.
- **Diffs a reviewer can read.** Evidence for `src/world.ts` sits in a file named after it, so a PR shows which code
  gained or lost evidence.
- **A machine name, not a fingerprint.** The environment class is coarse and the name is yours; nothing identifying the
  hardware is committed.

## Capture

Evidence is captured inside the runtimes, which only the editor's core can reach. Each capture point attaches what it
saw to the run by id, and when the run ends the registry hands the whole record to silo to write. One writer replaces
today's three.

| Runtime | What it runs | Evidence it can give |
|---|---|---|
| tsval | Terminal tasks, F5, the canary | Everything, exactly: every statement and expression passes through the interpreter. Values, types and branches need an `observe` option beside `coverage`, called at chosen node kinds. |
| almostnode | Services (dev servers, watchers) | Capabilities today. Coverage and values only with source instrumentation. |
| Preview | The app in the browser | Profiles and capabilities today. Coverage and values only by instrumenting modules as the dev server serves them, using the same span ids. |

Determinism is what makes "across all runs" a claim worth acting on: a lockstep game replays the same inputs to the
same values, so evidence from a replay counts as much as a live run.

## In VS Code

Every surface is an extension on VS Code's public API, so the same extension could read a repo's evidence on the
desktop.

- **Gutter**: coverage bars (today) and heat for time, colored by the decayed weight so stale evidence looks faint.
- **Hover**: everything known about the span under the cursor: runs, machines, values seen, types, branches,
  capabilities, how recent.
- **Diagnostics and quick fixes**: an unnecessary `?.` or `??`, a branch never taken, a declared type wider than
  anything observed. Hint severity, with the evidence in the message.
- **Inlay hints**: observed values or types inline, toggled on when you want to see what flowed through.
- **Changes since**: in a diff or the Source Control view: newly uncovered code, a function that got slower on one
  machine, a call site that gained network access.
- **Runs view**: a timeline of runs with their envelopes; picking one shows the evidence it added.

debug-mcp can answer the same questions for an agent: what ran, what was slow, what a span saw.

## Who owns what

- **silo** (`lib/util/silo`): the model and the files: envelope and observation types, decayed merge, the
  duplicate-line fold, reading and writing the layout through an fs it's given. Pure, so a CLI, CI or a desktop
  extension can use it too. Its whole-file confidence ratchet becomes per-span.
- **Editor core** (`packages/vscode`): capture and identity: the run registry's id carried everywhere, tsval's observe
  hook, mapping profiles and capability calls to spans, handing the finished record to silo.
- **The extension** (`extensions/insights`): what you see: reads the evidence files through `vscode.workspace.fs`,
  re-derives span ids for the open document, and draws the surfaces. Public API only.

## First slice: coverage, end to end

One kind of evidence through every layer, shaped so values and types can join without changing the store.

1. One run id: the registry's id reaches `node.start`, `debug.launch` and the debug session.
2. The envelope: user, environment class and name, commit and touched blob shas, written to `.silo/runs/<user>.jsonl`.
3. Coverage keyed by span: each statement's range mapped to its `spanAnchors` id when the run ends.
4. silo writes decayed `reached` lines to `.silo/evidence/<user>/<env>/<path>.jsonl`, with `merge=union` set up.
5. `.silo/` comes out of `.git/info/exclude`; `local/` is ignored instead.
6. The insights extension reads the files back: coverage survives a reload, stays put when a nearby line is edited,
   and clears for the statement you changed.

## Decisions

Decided 2026-10-03: every one as recommended (the **bold** option).

- **D1 · The key evidence attaches to.** spanAnchors ids are pure content: move-stable, and a self-edit orphans the
  span's evidence. reidentify maps a baseline onto current code, which can carry history across an edit.
  (a) spanAnchors only; (b) reidentify from the run's content only; **(c) spanAnchors as the key, with reidentify
  carrying enclosing spans' history across an edit at reduced weight**: the clean per-statement reset for free,
  without a function's profile vanishing when one line changes.
- **D2 · How evidence fades** (a self-edit already resets a span). (a) half-life in runs of the target; (b) in time;
  (c) in commits; **(d) runs, plus a time floor**, so a target nobody runs for months reads as stale.
- **D3 · What is committed.** (a) rollups only; **(b) rollups plus one envelope line per run**: tiny, and they answer
  "which runs, on what code, where"; (c) everything, raw profiles included.
- **D4 · How files are partitioned.** (a) per user; **(b) per user and environment**: timings only compare within one
  environment; (c) per user, environment and version (versions are already in the envelopes and span ids).
- **D5 · What identifies an environment.** **(a) a coarse class detected automatically, plus a name you choose**;
  (b) a detailed machine fingerprint; (c) only a name.
- **D6 · How evidence files are laid out.** **(a) one file per source file**, looked up across files when a span has
  moved; (b) one file per user and environment; (c) keyed by blob sha.
- **D7 · Which surfaces come first.** **(a) gutter and hover**: gutter exists, and hover shows every kind with no false
  positives; (b) diagnostics and quick fixes (once value evidence exists); (c) inlay hints; (d) changes since a commit.
- **D8 · Whether observed types feed TypeScript.** (a) never, diagnostics only; **(b) quick fixes that edit the
  declaration, on request**; (c) a tsserver plugin that narrows types from evidence; (d) generated declaration overlays.
- **D9 · Evidence beyond tsval** (services and preview apps run as real JavaScript). (a) tsval only; **(b) instrument
  modules as the dev server serves them, same span ids** (after the first slice); (c) V8 precise coverage only, no
  values.
- **D10 · Who writes the evidence.** **(a) the core run registry assembles the record; silo serializes it**: only the
  registry knows when every run ends; (b) each producer writes its own kind; (c) the insights extension writes
  everything.
- **D11 · Raw CPU profiles.** **(a) local only; hotspots fold into committed `time` evidence**; (b) commit them;
  (c) Git LFS.
- **D12 · How the code version is recorded.** (a) the commit only; **(b) the commit plus the blob sha of each file the
  run touched**: exact for dirty trees, still navigable by commit; (c) blob shas only.
