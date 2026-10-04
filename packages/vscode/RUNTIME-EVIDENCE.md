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

## Second slice: values, branches and types

The first slice records whether code ran. The second records what went through it, which way it went, and whether the
types held. Annotations can then use the same facts to re-place themselves when shape alone can't settle it
(SPAN-ANNOTATIONS.md, the typed strategy).

### What a run observes

tsval gets an `observe` option beside `coverage`. It's called at a few chosen sites, not at every expression, and the
debug worker sums what it reports while the run goes on. Nothing is kept per event.

| Site | Kind | What's summed |
|---|---|---|
| `a?.b`, `a?.()` | `value` of `a` | seen, nullish (the chain stopped), type tags |
| `a ?? b` | `value` of `a` | seen, nullish (the right side ran), type tags |
| `if`, `c ? x : y` | `branch` | how often each arm ran |
| `a && b`, `a \|\| b` | `branch` | how often the right side ran, and how often it didn't |
| a parameter | `value` | seen, nullish, type tags |
| a `return` | `value` | seen, nullish, type tags |

A **type tag** is what a value was at runtime: `undefined`, `null`, `boolean`, `number`, `string`, `bigint`, `symbol`,
`function`, `array`, or an object's class name (`Map`, `Player`; `object` for a plain one). Each site keeps at most
8 tags; anything past that counts as `other`.

### What's committed

Same files, new lines: `value` and `branch` observations join `reached` in
`.silo/evidence/<user>/<env>/<file>.jsonl`, one line per (kind, span), folded and faded the same way.

```json
{ "span": "9f3a…c2", "key": "bablr1", "kind": "value", "w": 38.4, "runs": 19.1,
  "seen": 1206, "nullish": 0, "tags": { "function": 1206 }, "lastRun": "…", "lastAt": "…" }
{ "span": "51c0…9a", "key": "bablr1", "kind": "branch", "w": 12.0, "runs": 19.1,
  "arms": [1180, 26], "lastRun": "…", "lastAt": "…" }
```

- **Strict counts for quick fixes.** `seen`, `nullish`, `tags` and `arms` count since the span last changed and are
  never faded. The span's id changes when its code does, so these reset by themselves. "Remove the `?.`" needs
  `nullish: 0` and enough `seen`. `w` and `runs` fade, and they say how recent and how strong the evidence is.
- **No values in git.** Tags and counts are committed. The values themselves stay out of git, because strings can be
  tokens, emails or anything else. A few distinct primitives per site (for "this was only ever `"left"` or
  `"right"`") are kept in `.silo/local/` on the machine that saw them.
- **Declared types aren't stored.** They're the code's, and TypeScript can say what they are at any time. "Did the types
  hold" is computed when it's shown: the declared type at the span against the tags its evidence saw.
- **Exact spans only.** A site is recorded under the BABLR span whose range is exactly the site's node: the `a?.b`
  member expression, the `??` expression, the `if` statement. A site without an exact span isn't recorded. The
  fallback statements use (pickAnchor's nearest enclosing span) would pool unrelated sites into one line.
- **Size.** One line per site that ran. A 300-line file has around 100 such sites, so about 15 KB per environment.

### How it flows

The path is coverage's, with nothing new: the debug worker's end-of-run report gains `sites` beside `statements`.
The adapter publishes both on `evidence.observed` (formerly `evidence.coverage`). `evidence.ts` maps each site's
range to its exact span, and silo folds `value` and `branch` beside `reached`. The insights extension reads them back.

### The typed strategy

Two facts help when shape alone is ambiguous: what TypeScript says a span's type is, and which types actually went
through it.

- **Recorded at reference time.** A `SpanRef` gains `inferred` (TypeScript's type for the span, as text) and
  `observed` (the span's type tags from evidence, when it has any). Both are optional; a reference without them
  resolves exactly as today.
- **A re-scorer, not a finder.** `typed` takes the same-shape strategy's candidates and adjusts their scores. A
  candidate whose inferred type matches, and whose observed tags overlap, is lifted; one whose types disagree is
  lowered. It can turn an *uncertain* match into a *re-placed* one, or push a wrong one below `askAt`. It never finds
  a span the shape didn't. Weights are a `TypedWeights` like the others, scored by the same corpus.
- **Where types come from.** The capabilities tsserver plugin already holds the project's real checker. It answers
  "the types at these ranges" as a plugin command, the way eslint's `_eslint.fixAll` is reached
  (`typescript.tsserverRequest`). The BABLR worker never loads TypeScript. tsval's own checker only knows its one file
  and the default libs, so it can't stand in.

### In VS Code

- **Hover** on a span shows its values (seen, how often nullish, its tags as a bar), its branches (each arm's share)
  and, for a declaration, the declared type against what was observed.
- **Then quick fixes**, hint severity, on request (D8): an unnecessary `?.` or `??` (never nullish since the span last
  changed, seen at least N times across at least M runs), and a branch never taken.

### Building it

1. **tsval**: `observe(node, site, value)` at the sites above, one `undefined` check when off, tested on its own.
   Done, with `typeTag(value)`: a value's tag read from property descriptors only, so tagging never runs a getter.
2. **The debug worker** sums each site's observations, and the report carries `sites`. Done (site-sums.ts): a fork
   goes on from a copy of its stop's sums, as its coverage does, so stepping back and forward doesn't count twice.
3. **silo**: `value` and `branch` observations, `foldValues` and `foldBranches`, the parser taking every kind.
   Done: every kind keeps `ever` (runs that observed it since its span changed), and each fold leaves the others alone.
4. **evidence.ts**: exact spans for sites, folded and written beside `reached`. Done: a site's span is the innermost
   one without an ordinal whose range is its node's (a statement's trailing `;` aside); samples go to
   `.silo/local/samples/<file>.jsonl`, kept only for sites the evidence still knows.
5. **Insights**: the hover. Done (extensions/insights/hover.ts, over evidence.ts, the store the gutter marks share):
   values, nullish, kinds and this machine's samples, or each arm's share, for the innermost span under the cursor,
   labelled by its node type. Declared against observed waits for step 7's types at ranges: TypeScript's own hover
   shows the declared type beside it until then.
6. **Quick fixes**: `?.` and `??`, then branches. Done (extensions/insights/fixes.ts): hints, with the evidence in the
   message, past `silo.evidence.minRuns` (3) and `silo.evidence.minSeen` (10); `?.` and `??` get a fix that removes
   them, a branch never taken only the hint — deleting code on evidence alone is for you to decide.
7. **The typed strategy**: types at ranges from the tsserver plugin, `inferred` and `observed` on references,
   `typed` in the pipeline, cases in the corpus. Done: `_types.at` (capabilities tsserver plugin) types each range as
   its site observes; `typed` re-scores same-shape candidates and treats `any` and `unknown` as saying nothing; notes
   keep `inferred` and, when a note is only matched by shape, look again with its candidates' types; the hover shows
   the declared type beside the observed kinds; notes keep `observed` too (the kinds of value runs saw at their span,
   read from the evidence), and give each candidate its own.

### Decisions for this slice

Decided 2026-10-04: every one as recommended (the **bold** option).

- **V1 · Where `observe` fires.** (a) after every expression (one generic hook in tsval's step loop); **(b) the sites
  above**: the ones behind the features, plus parameters and returns for types; (c) (b) plus every variable binding.
- **V2 · What a value summary keeps.** **(a) tags and counts committed, a few distinct primitives kept locally**;
  (b) primitives committed too; (c) tags and counts only, nowhere else.
- **V3 · Declared types.** **(a) not stored; compared when shown**; (b) stored with each observation.
- **V4 · Which span a site uses.** **(a) the exact span for its node, or none**; (b) pickAnchor's nearest span.
- **V5 · How it travels.** **(a) the one end-of-run report, `sites` beside `statements`**; (b) a channel per kind.
- **V6 · Where the typed strategy's types come from.** **(a) the tsserver plugin, as a plugin command**; (b) the hover
  provider, one request per range; (c) tsval's own checker.
- **V7 · What the typed strategy is.** **(a) a re-scorer of same-shape candidates**; (b) a finder of its own over every
  span of the node's type.
- **V8 · The first surface.** **(a) hover, then quick fixes**; (b) quick fixes first.

## Third slice: previews, under HMR

The second slice records what tsval runs observe. A preview, though, runs as real JavaScript in the browser (D9), and
it can stay open for hours while modules are swapped underneath it. This slice records the same evidence there: the
same kinds, the same sites, the same files.

### What's there to work with

- **The preview's dev server is ours.** It's almostnode's `ViteDevServer`, not Vite: it compiles each workspace
  module with `ts.transpileModule` (`transformCode`), with an inline source map. Dependencies come from the CDN and
  never pass through it.
- **HMR is ours too.** A change goes out on `preview.hmr.<port>`, and the injected client re-imports the module as a
  new instance (`?t=`). Only `.tsx`/`.jsx` modules get `import.meta.hot`; a `.ts` edit reloads the page.
- **The page already talks to the editor.** The page tap is a hub client in every preview page; the shell decides what
  it may publish.
- **A preview is a run.** `npm run dev` registers a service run with an id and its port (`runs.runningService(port)`).
  It ends on Ctrl-C, Stop, or when the last window closes, and the windows close before the run ends.

### Capture: a TypeScript transformer in the dev server

The dev server compiles a workspace module with one more step: a `before` transformer that instruments it. It works
on the original source's syntax tree, so every range it records is in the original file's lines and characters, and
the source map the compile emits stays right. No source maps need to be composed.

- **Sites as tsval's.** Statements count as they start; `?.` and `??` observe the value tested; `if`, `?:`, `&&`, `||`
  record the arm that ran; parameters and returns observe their values. Each wrapper returns what it was given and
  reads each value once, so the program does what it did before. A member callee (`obj.m?.()`) keeps its `this`.
- **Parameters with a default or a pattern aren't observed.** A transform can't see the argument a default replaced
  (arrow functions have no `arguments`), and evidence from tsval, which does see it, must mean the same thing.
- **Workspace files only.** Not `node_modules`, not `/@pkg/` files. The transform cache keys on the setting too.

### Counting: a page runtime that outlives hot updates

A small runtime, served like the page tap (`/@editor/…`) and injected into every preview page, keeps the counts. It's
page-global, keyed by file and version (the source's git blob oid), so a module re-imported after an edit counts into
its new version, and one re-imported unchanged counts on into its old one. A module's own scope would lose its counts
on every update. In a worker, the same runtime keeps its counts and reports through the worker tap.

### Reporting: often, and before the page goes

Each window reports what it has counted since it loaded, as totals rather than increments, so a lost report costs
nothing. It reports every 10 seconds while something changed, on each hot update, on `pagehide`, and when the editor
asks before the preview closes. That last one closes a gap: today the windows close before the run ends. Reports go
out on a new subject, `evidence.preview`, which the shell's link permissions let the page publish.

### Recording: core folds a preview run like any other

- **The run is found by port.** A report carries the page's port, and core finds the running service there. The page
  never needs to know a run id.
- **Versions, then spans.** Core keeps each window's latest totals per (file, version) until the run ends. Then it maps
  each version's ranges to spans through BABLR, adds up what every window and version saw under each span, and folds
  each file once. Code an HMR edit didn't touch has the same span ids in every version, so its counts add up across
  versions. Code that was edited has new ids, and its old counts stay with the old spans and fade.
- **Past versions' sources.** Mapping a version's ranges needs that version's text, which the file may no longer
  have. The dev server keeps each version it instrumented, by blob oid, for as long as it runs, and core asks it for
  the ones it needs.
- **The envelope says which versions ran.** `files` keeps each path's last version, and `versions` lists every oid of
  a path that more than one version of ran.
- **Fast Refresh keeps state across an edit**, so new code can see values that old code made. They're still values that
  went through the new code, so they count.

### Cost

Wrappers run on the app's hot paths, and a game's frame budget is tight. Statement counters are an increment; value
sites tag every value. The setting `silo.evidence.previews` (`full`, `coverage`, `off`) scales it back. The performance
budgets (test/performance.mjs) measure an instrumented preview before the default is chosen for good.

### Building it

1. **The transformer**, in almostnode beside its other code transforms, tested on its own: sites and ranges as tsval's,
   semantics unchanged. Done (frameworks/instrument.ts): a differential test runs the same programs in tsval and
   instrumented and finds the same evidence (test/preview-instrument.test.mjs); a later link of an optional chain names
   the one before it, so it goes untold when that one stopped the chain, as in tsval; tsval no longer observes
   parameters with a default or a pattern (P8).
2. **The page runtime** and its reports: counts by file and version, flushed as above, `evidence.preview` allowed
   through the link.
3. **Core**: reports gathered by run (by port), past versions' sources from the dev server, a last pull before the
   preview closes, folding at run end, `versions` in the envelope (silo).
4. **The setting and a performance check.**
5. **A tour test**: `npm run dev`, use the app, edit a module (a hot update), use it again, stop; evidence for both
   versions, the untouched code's counts added across them.

### Decisions for this slice

Decided 2026-10-04: every one as recommended (the **bold** option).

- **P1 · Where to instrument.** **(a) a TypeScript `before` transformer in the dev server's compile**; (b) rewrite the
  compiled output where responses pass (`answerVirtual`), composing source maps; (c) in the service worker.
- **P2 · Which files.** **(a) workspace `.ts`/`.tsx`/`.jsx`, and `.js`/`.mjs` sent through the same compile when
  instrumenting**; (b) only what the dev server compiles today (TypeScript and JSX).
- **P3 · What's on by default.** **(a) everything (`full`), measured against the performance budgets before it
  stays**; (b) coverage only; (c) off until asked for.
- **P4 · Where counts live.** **(a) a page-global runtime, by file and version**; (b) in each module's scope (lost on
  every hot update).
- **P5 · When a window reports.** **(a) totals, every 10 seconds while changing, on hot updates, on `pagehide`, and when
  asked before closing**; (b) only on `pagehide` and close.
- **P6 · How a report finds its run.** **(a) by port, in core**; (b) thread the run id into the dev server and the page.
- **P7 · Past versions' sources.** **(a) the dev server keeps them by blob oid, and core asks**; (b) each window sends
  a version's source with its first report; (c) only versions whose source the file still has are recorded.
- **P8 · Parameters.** **(a) only those without a default or pattern, in previews and tsval alike**; (b) previews
  observe the value after its default, tsval before; (c) no parameters in previews.
- **P9 · The envelope's versions.** **(a) `files` keeps the last version, `versions` lists every oid that ran**; (b)
  `files` only.

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
