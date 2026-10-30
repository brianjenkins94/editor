# Runtime evidence

The editor learns what your program actually does by running it: which code ran and how often, where the time went,
the values that passed through, whether the types held, which branches were taken, which capabilities it used. It keeps
that evidence in git beside the code, attached to stable spans rather than lines, and turns it into help you can act on.

```ts
world.onWin?.();
```

> Across the last 41 runs on two machines, `world.onWin` was a function every time it was reached (1,206 times), never
> `undefined`. **Quick fix: remove the `?.`**

This lays out the model every kind of evidence shares, where it lives, how it surfaces, and the decisions that shape it
(at the end). What one run shows beside its code, as it runs, is *Live values*, below.

## The model

A run is evidence about one version of the code in one environment. Each run has an envelope that says whose (the user,
as git knows them), where (a coarse environment class plus a machine name you choose), what (the commit, plus the blob
sha of each file the run touched, so a run on uncommitted code is pinned exactly), its outcome, and one id from start to
end, the core registry's. It lists each package whose code it ran, by `name@version` with its integrity when the
lockfile has it, so "did anyone run a version later found compromised?" is a question the committed runs answer (silo's
`queryRuns({ package })`); a package's own `fs` and `child_process` calls are among the run's effects as that
package's, recorded, not decided (the editor runs it sandboxed already).

**An observation** is a kind, a span, and a summary that stays the same size however many runs feed it. Four kinds are
kept: `reached` (how often a statement ran), `value` (what passed through: type tags, nullish count), `branch` (how
often each arm was taken) and `purity` (a function's calls, and how many wrote outside it, made an effect, read the
clock or random numbers, or went into code a run can't see into: packages/silo/README.md, *Purity*). `type` (the declared type against the observed values) is computed when it's shown (V3).
`time` (a function's self and total time, from profiles), `capability` (which scope a call site exercised) and `error`
(throws and rejections at a span) are kinds the model has room for; none is kept as evidence yet. New kinds are new
lines with the same envelope and the same span key. Nothing about the store changes when one is added.

## Recency

The code changes constantly, so evidence has to fade. Two mechanisms do most of the work, and one is free.

- **Editing a span gives it a new id.** A span's id is a hash of its node type and its content, ignoring whitespace and
  comments. Edit a statement and its evidence no longer attaches; the statements you didn't touch keep theirs. The
  catch is that every enclosing span changes too: edit one line and its function's id changes, so the function's
  profile would start over unless history is carried across (D1, D2).
- **Each run weighs less as newer runs arrive.** Every counter is stored decayed: on each run of its target,
  `w = w × 2^(−1/H) + new`, with a half-life `H` in runs (20). It's one multiply per update, the summary stays a fixed
  size forever, and no raw history is needed to know what recent runs said. (D2's time floor isn't built.)

A suggestion that edits your code needs a strict claim, not just a weighted one: "remove the `?.`" fires only if the
span was reached in enough recent runs and was never nullish since the span last changed. The decayed weight decides
how confident the hover sounds; the strict count decides whether a quick fix appears.

## Storage in git

Evidence is committed beside the code, so it travels with the repo, shows in review and survives a fresh clone. The
layout is silo's (lib `util/silo/layout.ts`): runs in `.silo/runs/<user>.jsonl`, an envelope a line; evidence in
`.silo/evidence/<user>/<env>/<file>.jsonl`, a line per (span, kind); `.silo/local/` (raw profiles, value samples, every
run's trace) stays on the machine.

The files the editor makes for a project — `versions.json` (the versions it pins), `baseline.json` (the dependency
baseline) and `capabilities.json` (the static surface) — are the repository's at `.silo/` once it has committed them,
and in `.silo/local/` until then (2026-10-30; editor-api's git.ts `keptAt`), so loading a repository doesn't put them
in its next commit. A repository shares one by committing it at its `.silo/` path; one an earlier editor left there
untracked moves to `.silo/local/` as the workspace opens (git-engine.ts `includeSilo`). `.silo/local/` is kept out of
git by `.git/info/exclude` (git's own ignore for one machine, never committed), and `.silo/`'s own `.gitignore` and
`.gitattributes` go into a commit only with something else under `.silo/`: a repository the editor merely loaded gets
nothing of `.silo/` in its commits.

- **Conflict-free by partition.** Each user and environment writes only its own files. One user on two branches does
  touch the same files; with one sorted line per span, git's built-in `merge=union` keeps both sides without any setup,
  and the reader folds duplicate lines for a span (largest `lastRun` wins, counts combine).
- **Bounded size.** Decayed summaries don't grow with run count. Only spans that produced evidence get a line: about
  150 statements for a 300-line file, roughly 6 KB of coverage per environment.
- **Diffs a reviewer can read**, a file per source file; and **a machine name, not a fingerprint**: nothing
  identifying the hardware is committed.

Evidence is captured inside the runtimes, which only the editor's core can reach, and when the run ends the registry
hands the whole record to silo to write (D10). tsval sees everything exactly; almostnode's services and a preview's pages
run real JavaScript, so they're instrumented as the dev server serves their modules (*Third slice*). Determinism is what
makes "across all runs" a claim worth acting on: a lockstep game replays the same inputs to the same values, so evidence
from a replay counts as much as a live run.

Every surface is an extension on VS Code's public API, so it could read a repo's evidence on the desktop. Built:
coverage in the Margin's gutter column (*The margin, always open*), the hover, and hints with fixes (*Fourth slice*). Not
built: heat for time in the gutter, faint where the evidence is stale; inlay hints of observed values or types; changes
since a commit (newly uncovered code, a function that got slower on one machine, a call site that gained network
access); a runs view, a timeline of envelopes.

## Second slice: values, branches and types

The first slice recorded whether code ran. The second records what went through it, which way it went, and whether the
types held. Annotations can then use the same facts to re-place themselves when shape alone can't settle it (*The
typed strategy*, below).

### What a run observes

tsval's `observe` option is called at a few chosen sites, not at every expression, and the debug worker sums what it
reports while the run goes on (site-sums.ts). Nothing is kept per event. `a?.b`, `a?.()` and `a ?? b` sum the `value` of
`a` (seen, nullish, type tags); `if`, `?:`, `&&` and `||` a `branch` (how often each arm ran); a parameter and a
`return` their `value`.

A **type tag** is what a value was at runtime: a primitive's type, `function`, `array`, or an object's class name (`Map`,
`Player`; `object` for a plain one), at most 8 a site, the rest `other`. Tagging never runs a getter.

### What's committed

- **Strict counts for quick fixes.** `seen`, `nullish`, `tags` and `arms` count since the span last changed and are
  never faded. The span's id changes when its code does, so these reset by themselves. "Remove the `?.`" needs
  `nullish: 0` and enough `seen`. `w` and `runs` fade, and they say how recent and how strong the evidence is.
- **No values in git.** Tags and counts are committed. The values themselves stay out of git, because strings can be
  tokens, emails or anything else. A few distinct primitives per site (for "this was only ever `"left"` or
  `"right"`") are kept in `.silo/local/samples/` on the machine that saw them.
- **Declared types aren't stored.** They're the code's: "did the types hold" is computed when it's shown (V3).
- **Exact spans only.** A site is recorded under the BABLR span whose range is exactly the site's node. A site without
  an exact span isn't recorded. The fallback statements use (pickAnchor's nearest enclosing span) would pool unrelated
  sites into one line.
- **Size.** One line per site that ran. A 300-line file has around 100 such sites, so about 15 KB per environment.

### The typed strategy

Two facts help when shape alone is ambiguous: what TypeScript says a span's type is, and which types actually went
through it. A `SpanRef` records both at reference time (`inferred`, `observed`), optionally.

- **A re-scorer, not a finder.** `typed` takes the same-shape strategy's candidates and adjusts their scores. A
  candidate whose inferred type matches, and whose observed tags overlap, is lifted; one whose types disagree is
  lowered. It can turn an *uncertain* match into a *re-placed* one, or push a wrong one below `askAt`. It never finds
  a span the shape didn't. `any` and `unknown` say nothing.
- **Where types come from.** The capabilities tsserver plugin already holds the project's real checker; it answers
  `_types.at` through `typescript.tsserverRequest`. The BABLR worker never loads TypeScript. tsval's own checker only
  knows its one file and the default libs, so it can't stand in.

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

A preview runs as real JavaScript in the browser (D9), and it can stay open for hours while modules are swapped
underneath it. This slice records the same evidence there: the same kinds, the same sites, the same files.

**Capture: a TypeScript transformer in the dev server.** The preview's dev server is almostnode's, not Vite: it compiles
each workspace module with `ts.transpileModule`. Instrumenting is a `before` transformer in that compile
(frameworks/instrument.ts). It works on the original source's syntax tree, so every range it records is in the original
file's lines, and the source map the compile emits stays right; no source maps need composing. Its sites are tsval's,
and a differential test runs the same programs in both and expects the same evidence (test/preview-instrument.test.mjs).
**Parameters with a default or a pattern aren't observed**, in either (P8): a transform can't see the argument a default
replaced (arrow functions have no `arguments`), and evidence from tsval, which does see it, must mean the same thing.

**Counting: a page runtime that outlives hot updates** (previews/page-evidence.ts). It's page-global, keyed by file and
version (the source's git blob oid), so a module re-imported after an edit counts into its new version, and one
re-imported unchanged counts on into its old one. A module's own scope would lose its counts on every update.

**Reporting: often, and before the page goes.** Each page reports what it has counted since it loaded, as totals rather
than increments, so a lost report costs nothing. It reports every 10 seconds while something changed, on each hot
update, on `pagehide`, and when the editor asks before the preview closes (`evidence.flush`): a preview's windows close
before its run ends.

**Recording: core folds a preview run like any other.** A report carries the page's port, and core finds the run there,
so the page never needs to know a run id (P6).

- **Versions, then spans.** Core keeps each page's latest totals per (file, version) until the run ends. Then it maps
  each version's ranges to spans through BABLR, adds up what every page and version saw under each span, and folds each
  file once. Code an HMR edit didn't touch has the same span ids in every version, so its counts add up across
  versions. Code that was edited has new ids, and its old counts stay with the old spans and fade.
- **Past versions' sources.** Mapping a version's ranges needs that version's text, which the file may no longer have.
  The dev server keeps each version it instrumented, by blob oid, for as long as it runs (`preview.version`).
- **Fast Refresh keeps state across an edit**, so new code can see values that old code made. They're still values that
  went through the new code, so they count.

**Cost.** Wrappers run on the app's hot paths, and a game's frame budget is tight. test/preview-instrument-cost.mjs times
a game-like hot loop (vector math, property reads, `?.`, `??`, branches, small calls), pure JavaScript and so the worst
case: `coverage` ×1.4, `full` ×2.9 (the wrapper calls alone are ×1.9; the page runtime counts in typed arrays, with a
fast path for a site's usual kind, and `typeTag` reads a prototype's class once). An app that spends its frames in the
DOM or a canvas pays less. `silo.evidence.previews` (`full`, `coverage`, `off`) scales it back; `full` stays the
default, and a preview with a tight frame budget drops to `coverage`.

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

## Fourth slice: what could go, in purple, across inputs

The point of running a program many times: what none of the runs needed is code that could go. Decided 2026-10-05.

- **Purple is the evidence's color**: a wavy underline for an operator that could go, a tint for code that never ran.
  Each is a Hint diagnostic too, with a fix; nothing is applied for you. Coverage has no line background, so a line that
  never ran isn't red and purple at once.
- **A Suggestions view, beside Problems**: VS Code's Problems view doesn't list hints, and raising them to Information
  would put VS Code's own squiggle under the purple. It reads files from disk rather than opening them as documents, so
  tsserver isn't handed every file with evidence.
- **Never isn't proof.** Each message says how rare it could still be, by the rule of three: with none in n tries, at
  most 3/n of the time, 95% sure ("at most 1 in 4, 95% sure"), or too few tries yet under six. The purple grows
  stronger with the tries (under 30, under 300, more). The thresholds are `silo.evidence.minRuns` (3) and `minSeen` (10).
- **Runs take inputs.** A rule gives `process.argv` (*Mocking a value*, below), and a run of several cases runs the
  file once per set (extensions/margin/inputs.ts). What none of the inputs reached is what turns purple. Inputs beyond
  arguments (stdin, files, a function's own arguments) and generated ones want a design of their own.

## Durable annotations on spans

One way for anything attached to code — evidence, notes, a dismissed suggestion, a call site's decision, an event-sheet
part — to stay attached as the code moves and changes, and one way to handle losing its place: the user re-places or
dismisses it. (Built 2026-10-04 to 10-10. Inline comment notes came first and were removed on 2026-09-17, `49ce737`: "no
reason for multiple annotation types" — this is that one type.)

BABLR's `spanAnchors` ids are content-addressed: a span keeps its id when code around it moves or changes, even into
another file, and gets a new one when it's edited itself. `reidentify` (bablr-language-ts identity.ts) maps nodes from
an older version of a file onto the current one; `pickAnchor` turns a range into the span that best stands for it.

| | Observed | Authored |
|---|---|---|
| Examples | coverage, timings, values, capability calls seen | notes, dismissed suggestions, call-site decisions, snippets |
| Where it comes from | runs, many times over | a person, once |
| When its place is lost | it fades: new runs make new evidence | it's kept, and the user re-places or dismisses it |

Observed annotations carry only a span id. Authored ones must never vanish silently, so they carry enough to be found
again:

```json
{ "span": "9f3a…c2", "key": "bablr1", "file": "src/world.ts",
  "baseline": { "blob": "3b18e5…", "start": 412, "end": 431 },
  "shape": { "type": "CallExpression", "atoms": ["world", ".", "onWin", "?.", "(", ")"] },
  "context": { "before": "51c0…9a", "after": "e2d4…07" } }
```

`baseline` is the file's git blob when the span was last placed and its offsets there; `shape` its node type and tokens
(trivia left out); `context` the ids of its neighbours, which usually survive an edit to the span itself.

**Finding its place.** Matching is kept apart from deciding. *Strategies* are pure functions scoring candidates 0–1,
tried in a listed order, stopping at a certain match:

1. **Same span** — its id is in the file's spans (1).
2. **Moved** — its id is in another file's spans; the files looked in are those differing from HEAD (0.95).
3. **Re-identified** — from its baseline in git's objects, follow the node through BABLR's structural diff (`follow`).
   The diff compares a container by type alone, so it survives edits inside it, and a call replaced by another call is
   "the same" too: 0.6 for a node the diff kept, plus up to 0.35 for how much of its head (callee and first arguments,
   name and signature) survived.
4. **Same shape** — spans of its type, scored by shared tokens, neighbours still beside it, and nearness.
   `fn(foo, bar, baz)` → `fn(foo, bar, baz2)`: a new id, 7 of 8 tokens and both neighbours, so it re-places on its own.
5. **The typed strategy** — the span's inferred type and the kinds of value runs saw there re-score same-shape
   candidates (*Second slice*, above).

*A policy* turns the best score into what happens: at or above `autoAt` (with no close second) it re-places on its own;
at or above `askAt` it's *uncertain*, shown with confirm and re-place; below, *orphaned*, kept with its last file and
line, in the Problems view (Information severity: VS Code leaves hints out) with code actions Re-place (select the code;
`pickAnchor`) and Dismiss (a tombstone line, so a merge can't bring it back). Every resolution records its strategy
and score; a corpus of edit cases scores pipelines and policies against each other. Observed annotations use 1–2 only.
An authored annotation found by 2–4 is rewritten by its owner (each person writes only their own files), so the next
read finds it by 1; others' resolve on read without being rewritten. Baselines come from git's objects only, so this
works for committed code.

**Storage:** `.silo/<collection>/<user>/<file>.jsonl`, one sorted line per annotation, `merge=union`, folded on read by
id, the last update winning, tombstones folded the same way; a collection may partition further (evidence by
environment).

**Who does what:** silo (lib `util/silo`) has the line types, the fold, strategies 1, 2 and 4, the policy and the
resolver, all pure. The editor's BABLR worker has spans with shapes and neighbours, references for ranges, and strategy
3, from cached parses, reached through two batched commands typed in `@brianjenkins94/editor-api/annotations`:
`editor.annotations.refer(text, file, ranges)` and `editor.annotations.resolve(text, file, refs, { observed })`. A text
BABLR can't parse answers `unparsable`, never a lost annotation: what's placed stays put until it parses, and the file
is flagged in Problems. Core reads baselines from git; notes (extensions/notes), evidence and the event sheet are its
users. A note whose code moved to another file follows once that file is saved (a tombstone in the old file's notes);
a move that arrives committed (pulled) isn't a changed file, so that note is asked about.

## Live values

What one run did, beside the code: for each line, the values it computed, a column per time it ran — the right-hand
side of Bret Victor's *Inventing on Principle* binary search. You read the code on the left and see, line by line, what
it was in this run: `mid = 2 | 4 | 3`, `value = 'c' | 'e' | 'd'`, `return 3`. It's the Margin (extensions/margin), the
file's runtime column, open beside every JavaScript or TypeScript file. Decided 2026-10-05:

- **Its values come from a debug session.** The debug worker records each statement's values as it runs them (tsval's
  `trace`, beside `observe`), and the debugger's adapter passes them on as the run contract's custom events (`values`,
  `ended`, `ask`), so any debugger can feed it. No new store: runtime evidence keeps runs; this is what the last run
  showed, in memory. (Since 2026-10-22 runs are kept too: *Runs kept, as balls*.)
- **Bounded**, because a session can run forever: a value as the debugger's Variables view shows it, a loop's first
  50 turns, 2000 values a call and 200 calls, the rest counted and said ("… 20 more values not kept"; `LiveRecord`,
  packages/editor-api/src/values.ts).
- **Inputs are pipe-delimited, for now**: runs by `|`, a run's arguments by spaces, read as `process.argv`.
- **A preview's page can't stop**, so a breakpoint in its code is a recorded stop: what's in scope each time its line
  runs, shown the same way (extensions/bridge/recorded-stops.ts; RUNNING.md).

### Spike: Code Hike inside Monaco

Code Hike (the review panel's diff renderer: shell/git-codehike.tsx) can render inside Monaco. A spike showed it
(2026-10-06, since removed): `<Pre>` in an overlay widget over the editor's text area, in its font, line height and tab
size, moved with its scroll; Monaco's own glyphs transparent, so what's seen is Code Hike's rendering while Monaco keeps
editing, the cursor, the selection and bracket matching, all aligned. A handler that adds height (a callout under a line)
got a Monaco view zone as tall, so every line below stayed aligned. What it showed: **annotations must be given, not
written** (Code Hike strips `// !` comments, which would put its lines out of step with Monaco's); **columns are drawn,
not counted** (Code Hike counts a tab as one column); **anything Monaco inserts into a line breaks alignment there**
(inlay hints, inline suggestions, injected text, word wrap, folding), so each wants turning off or bringing into Code
Hike; **use Monaco's tokens, not shiki's** (the theme's colors, nothing fetched from lighter.codehike.org, re-rendering
synchronous); **render what's visible**; and **a handler that adds height says how much**, so its view zone can be made
first.

### The right-hand side, not an overlay

Decided 2026-10-05, after the spike: not drawn over Monaco's text, but a pane beside it — literate programming,
explanatory prose beside the code it explains — and Victor's values are the same thing. One pane, one kind of anchor.
The pane is an overlay inside the editor, not an editor group of its own: one scroll, nothing to synchronize. Monaco is
the row sizer: a cell taller than its span gets a view zone after the span's last line for the difference, so the pane
and the code can't drift. Notes in the pane were dropped (2026-10-12): notes are the notes extension's comment threads.
The pane's tabs are pane views (ARCHITECTURE.md, *Extension points* 4); the Margin's content is data that core's pane-views.ts draws.

### The margin, always open

- **Coverage moved into the margin's gutter column.** Gutter icons cost breakpoints: VS Code won't set one on a line
  whose glyph margin holds another extension's icon (`marginFreeFromNonDebugDecorations`, which lets through only
  codicons and its own test coverage's class, a class an extension's decoration can't choose). So the margin draws it
  (extensions/margin/coverage.ts) in a column at the left end of the line-decorations lane, where VS Code's change bars
  went (`scm.diffDecorations: none`; the shell's Changes panel is the git UI), each mark as VS Code draws a change bar:
  VS Code's coverage colours are tints for a whole line-number cell, too faint for a 3px bar. (Tried and dropped:
  tinting the line numbers; a column left of them; one widening the lane just left of the code.) How the last run ended
  short is in that column too: ✕ where it crashed (tsval's `throwSite`: by the time an uncaught error reaches the host
  its frames have unwound), ■ where a stopped session was paused.
- **Everything a run put on a line follows its code through cosmetic changes** and through edits elsewhere: each item
  carries its node's range in the text that ran, anchored once to BABLR's span and drawn where that span is found now.
  **A statement with a body is anchored by its head** — an `if`'s condition, a loop's header, a function's name —
  because a body's span changes with any token in it (a semicolon dropped inside orphans the whole `if`; the
  condition's survives). Half-typed text that doesn't parse follows the lines around the edit instead, until it parses.
- **At a stop, its values are VS Code's own inline values too** (ARCHITECTURE.md, *Extension points* 6), so they'd show with no pane
  beside the editor (a desktop build). A value can be set at a stop from its row, as a literal, never run.

### Capability decisions, on the line

A call the policy hasn't decided (a write, a fetch, a spawn) stops the run at its line. The question goes there, on the
line that provoked it, with what the call would do from the run's own values (`writeFileSync '/workspace/out.txt'
fs:write`): *Allow ▾*, *Skip ▾*, *Deny ▾*, each for this call, this run or always (my policy, for the resource the call
reaches), and *Rule…* for anything finer. *Skip*: the call isn't made, the run goes on with the debugger's inert
stand-in's result. Where there's no stand-in (the preview's network gate) a skip is refused. A capability line is armed
from the source alone, so a stop checks the call's actual resource against the policy and goes on when it's allowed.

### Mocking a value — and one way to run

Decided 2026-10-06. There were three ways to run a file, and they didn't agree: F5, the editor's ▷ (*Run with
Inputs…*, `noDebug` runs that never stop) and the top bar's ▷ (the project's scripts and tasks). Run with Inputs existed
only to give a program different `process.argv`s, and a launch without `args` already took the first set it
remembered, a hidden stub. So **what a program reads from outside is mocked in the margin, and there's one way to run
it**: a debug session (*Run*); the top bar's ▷ offers this file first.

`process.argv`'s row is on the first line that reads it, shown before any run, so the inputs can be written first; its
*Mock…* opens the rule editor (RUNNING.md, *Rules*). A variable's row has *Mock…* too (*at* <this statement>, *then set* it). The
seams come in two slices: `process.argv`, then a capability call's result (*give* it, by a rule whose *when* is the
call, with the *record-at-seams* corpus of silo's design/fail-loud.md recorded beside it). Rules are kept in the policy files (`.silo/policy/<you>.json`, committed, so a repo's inputs travel with it); a value
recorded from a real run (a real fetch response can hold secrets) in `.silo/local/`, referred to by the rule.

### Live runs

Decided 2026-10-08, Victor's immediate connection: the file runs again and the margin shows what it did, without Run.
It waited on two things: every run is a debug run (RUNNING.md), and tsval is fast enough: a small file's run, session
and worker included, takes 170–330 ms from the workbench.

- **Quiet.** A tsval debug session with no debug toolbar or Debug Console, not in the running list, stopping at nothing
  (breakpoints are yours to hit with F5). A rule still applies.
- **What it does to the world: nothing it wasn't allowed.** Nobody is watching (a rule's `trigger is edit`), so it asks
  nothing: a rule's given result first; a read the policy allows made for real; else what the call returned when it
  last ran for real, if recorded (`.silo/local/recorded.json`; its line says *replayed*); else **skipped**. *Rule…* on
  such a line keeps what runs after an edit do with that call.
- **How long.** It ends at its first idle (a server waiting for requests opens no preview), or at a budget of steps,
  saying so where it stopped (*Run to finish*). Only a finished run replaces what the margin shows.

**Revised 2026-10-22: on a save, and on an interval** (RUNNING.md, *Unattended runs*), not as typing pauses. Ctrl+S runs
the file (the last of a burst of saves, 250 ms apart; not again if that text started a run in the last second), and so
does `run.liveRuns.interval` (5 seconds by default, 0 for saves only) while the file in front of you, edited, differs
from what its last run ran. An edit still stops the one going. A save reformats first when the workspace fixes on save
(ESLint's), so the tour finds rows by what they say, not their line.

### Runs kept, as balls

Jack Rusher's *Stop Writing Dead Programs* (Strange Loop 2022). Each run of the file is kept, the last eight, with its
values and how it ended: the record of what things were in that run. At the Margin's top, a ball for each, the latest
held, the colour how it ended (ran, crashed, stopped short). A finished run rolls its ball down the gutter column through
the lines it went, in the order it went (at most 400 steps), then the ball settles. Picking an older ball shows its
values again, where its code can still be found, and rolls its ball.

A run going for more than a second (2026-10-24) has its ball out beside the line it's on, following it batch by batch,
and settling where it ended rather than rolling from the top. A run holds the debug worker while it goes, so the
values are told from its trace every quarter second, not only by a timer; and each batch says where the run is even
when its values there weren't kept (`LiveBatch.now`), so the ball follows it past the bounds, and their count goes up
as it runs. A live run on a save stops at its step budget well inside the second, so it's a Run that's followed.

### Kept across reloads and deduped, on this machine

2026-10-22 (lib util/silo/traces; extensions/margin/runs.ts). A finished run is kept as a trace (its values, calls, how
it ended, what it read, the text it ran) and identified by its code: the BABLR span ids of the top-level declarations it
executed, each value by the span around it. Span ids ignore whitespace and comments, so a reformat, a comment or an
edit to a function the run never called leaves it the same run (*3 runs alike*), and an edit inside anything it executed
makes another. Every run stays on this machine (`.silo/local/traces/<file>.jsonl`), so a file's balls come back when
it's shown again.

**Never in git** (decided 2026-10-26). A value can hold anything a run read, so traces aren't committed; what runs
observed is shared as evidence, summed (*The model*: reached, value, branch, purity), and a run's envelope is shared in
`.silo/runs/` (whose, where, on what code; no values). Sharing them had been built on 2026-10-22, at each commit, with a
run that read shared by its values' types and a static floor of values built from literals shared as they were; all of
that went with it, and the runtime taint it was to be raised by wasn't built.

### Live values, open

- **The bounds**, and how many calls the margin lets you pick between.
- ~~**A picked run's coverage and run log**~~: built 2026-10-23 — each run keeps the coverage marks and profile it had as the
  latest, and a picked one shows its own (the latest shows the marks as they are now, following edits).

### Projections: cards, and later editing as cards

A program shown as something other than its text, and later edited that way. Written 2026-10-06 from a picture of macOS
Automator: a workflow as a column of action cards, each with its options and results, typed values flowing between
them, Step and Run in the toolbar, a log with each action's duration. Almost all of it is already here, made for other
reasons:

| Automator | here |
|---|---|
| The cards, top to bottom | A function's statements, from its BABLR tree, each with a durable identity (*Durable annotations on spans*) |
| A card's options | A call's arguments; the rule editor already draws an input from a schema (rule-editor.ts) |
| What flows between cards | The types a run observes at each range |
| *Results* under a card | The Margin's live values |
| Step, Stop, Run | The tsval debugger — and back, which Automator can't |
| Record | Recording what a call returned, at its seam (RUNNING.md, *A call's result*) |
| The log, a duration per action | Runs, coverage and profiling, on spans |
| The action library | The rules catalog, and later palette blocks promoted from a project's own functions |
| A card's settings saved with the workflow | Rules: `{ when, then }`, mocks and decisions, in the policy files |

The model: **the text is the truth, cards a view of it** (reading first, as the event sheet decided; writing back
after). **Interlocking**: a card shows what it takes and gives, and one dropped in is offered only where its input is
satisfied; statement order stays the control flow. **One editor for options**, drawn from schemas as rules' are. **No
black boxes**: a library card is a function in the same material. **Not only games**: the event sheet is this loop with
a game palette; a script, a server's routes, an app's state are other palettes.

**Built: cards in the Margin**, read-only, around the lines they stand for. A card is a step, not a statement:
consecutive top-level statements with no blank line between are one step, a `//` comment above starts one and titles
it, a function or class is its own. Its bottom border says its title, what it is and whether it ran, from coverage's
marks. They come from the capabilities plugin's `_statements`, grouped into steps by margin.ts. **The run log**, after
the last card: the last run step by step, each with its share of the run's work and any wait. Work is statements run
(tsval's `profile`, the statement clock), not wall time, so it's the same every run; waits are on the virtual clock.
**The pane's tabs line** holds *Margin* and the projections to come (*Cards*, *Event sheet*): a projection is a view in
that strip, not a third column, since the code and the pane are already a line-for-line grid.

Next: options edited on a card for a call's literal arguments, written back; then a library to drag calls from; then
interlocking. Open: what a card is inside a longer function (its body's paragraphs as cards, or folded as code); how
loops and branches look (Automator has none; the event sheet's rows and groups do).

## Open questions

The slices were built quickly, their decisions taken as recommended. These deserve another look as real use arrives,
roughly in order of how much it would cost to change them later.

### Before more is built on them

- **Is committing evidence the right default?** D3 was decided when only tsval runs wrote evidence. Previews now
  write it on every dev session, so ordinary work rewrites `.silo/evidence/…` constantly: noisy diffs, `merge=union`
  folding on every branch, files that grow with every user and machine. The alternatives: evidence local by default
  (`.silo/local/`) and a rollup committed on request; or committed at a cadence (on commit, daily) rather than per run.
  What would settle it: a week of real use, and how the diffs read in review.
- **One rule for which span stands for a node.** Evidence takes the innermost span without an ordinal whose range is
  exactly the node's (workbench/evidence.ts, `anchors(…, exact)`); notes take `pickAnchor` over the selection. They
  agree today (pickAnchor prefers ids without an ordinal, then the larger, and keeps the first of equals, which is the
  innermost), but nothing holds them together: if either changes, a note and the evidence at its code silently stop
  meeting. One function both use would.
- **BABLR as the key for everything.** Notes, evidence, the hover, the hints, live values and the event sheet all ride
  on `spanAnchors` ids. A file its grammar doesn't take gets no evidence and no notes; a parse costs about 14 ms a line;
  an id with an ordinal (`#n`) shifts when the same code turns up earlier in its file. Kept by choice (BABLR's
  performance work is coming); worth watching how often each of these bites.

### Defaults to revisit with real use

- **Previews instrument in `full` by default.** About ×3 on a pure-JavaScript hot loop (×1.4 for `coverage`). For a
  game at 60 frames a second, `coverage` may be the better default, with `full` on request.
- **The quick-fix thresholds** (`silo.evidence.minRuns` 3, `minSeen` 10). Evidence covers only the paths runs took:
  "never nullish" can hold for every path that ran and not for one that didn't. Higher thresholds, or the surrounding
  code's coverage shown beside the hint, before a fix is trusted.
- **The typed strategy's weights** came from reasoning and one case, not data; the corpus has six cases. Every
  placement records the strategy and score that made it, so they can be tuned once there's something to tune against.

### Bottlenecks to expect

- **One BABLR worker** answers notes, the hover, the hints, live values, every annotation's resolution and, at a preview
  run's end, every version of every file it ran. The pool (deferred) goes behind workbench/bablr.ts's `request`.
- **More hub channels** (`evidence.observed`, `evidence.preview`, `evidence.flush`, `evidence.level`, `preview.version`)
  against the aim of fewer connections. `evidence.level` could ride on `preview.start`.
- **`_types.at` lives in the capabilities tsserver plugin**, the expedient home since it holds the checker. A small
  types plugin of its own if it grows.

### Not built, worth considering

- **An evidence diff: what an edit changed at runtime.** Evidence is kept per span, spans survive edits, and runs
  record the version of each file they ran (its blob oid). Comparing a span's evidence before and after a version
  would answer "what did this edit change?": a branch arm that stopped firing, a value or observed type that's new at
  a span, a `catch` body that started running, coverage lost. It's a fold over what's already recorded, not new capture,
  and it would check an edit — an agent's especially — without a test written for it. A tool on debug-mcp beside the
  hover. (Shrike's `compare_actions` diffs two recorded clicks; this diffs a span's history across a code change.)
  Open: what "before" is when recency already blends versions (the last run of the previous version, or everything
  before it), and how few runs after an edit are enough to say something stopped.

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
