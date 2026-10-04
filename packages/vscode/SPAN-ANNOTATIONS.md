# Durable annotations on code spans

One way for anything the editor attaches to code — runtime evidence, notes, a dismissed suggestion, a call site's
capability decision, an event-sheet snippet — to stay attached as the code moves and changes, and one way to handle the
case where it can't find its place: the user re-places it or dismisses it.

## What exists

- **Runtime evidence** (`.silo/evidence/`, RUNTIME-EVIDENCE.md) keys each observation on a BABLR `spanAnchors` id.
  On read, the insights extension finds each id in the current text through the resolver's observed pipeline; a miss
  is simply not shown, and the observation fades away over later runs.
- **The event sheet** gives each recognized part a span reference (`editor.annotations.refer`), recomputed on every
  projection — what anything attached to a part will keep; nothing is persisted yet.
- **Notes** (extensions/notes), the first authored kind.
- **Inline comment notes** were built on the same ids and removed on 2026-09-17 (`49ce737`): "no reason for multiple
  annotation types". This standard is that one type.

The tools are there: `spanAnchors` ids are content-addressed, so a span keeps its id when code around it moves or
changes, even into another file, and gets a new one when it's edited itself. `reidentify` (bablr-language-ts
identity.ts) maps nodes from an older version of a file onto the current one. `pickAnchor` turns a range into the span
that best stands for it.

## Two kinds of annotation

| | Observed | Authored |
|---|---|---|
| Examples | coverage, timings, values, capability calls seen | notes, dismissed suggestions, call-site decisions, snippets |
| Where it comes from | runs, many times over | a person, once |
| When its place is lost | it fades: new runs make new evidence | it's kept, and the user re-places or dismisses it |

Observed annotations are cheap and many; they carry only a span id. Authored ones are few and must never vanish
silently; they carry enough to be found again.

## A span reference

Every authored annotation refers to its span the same way:

```json
{ "span": "9f3a…c2", "key": "bablr1", "file": "src/world.ts",
  "baseline": { "blob": "3b18e5…", "start": 412, "end": 431 },
  "shape": { "type": "CallExpression", "atoms": ["world", ".", "onWin", "?.", "(", ")"] },
  "context": { "before": "51c0…9a", "after": "e2d4…07" } }
```

- `span`, `key`: the `spanAnchors` id and the scheme that made it.
- `file`: where it was last found.
- `baseline`: the git blob oid of the file's content when the span was last placed, and the span's offsets in it.
- `shape`: the span's node type and its tokens, whitespace and comments left out — what it looked like.
- `context`: the ids of the spans just before and after it — where it was. Neighbours usually survive an edit to the
  span itself (its enclosing span doesn't: it contains the edit).

## Finding its place

Matching is kept apart from deciding, so either can be tuned, swapped or experimented with on its own:

- **Strategies** each look for the span their own way and score what they find, from 0 to 1. They're independent,
  pure functions over the reference and the current text's spans, and the order they're tried in is a list.
- **A policy** turns the best score into what happens: at or above `autoAt`, the annotation is re-placed on its own;
  at or above `askAt`, it's attached as *uncertain* and shown with confirm and re-place; below, it's *orphaned*. Two
  candidates scoring within a margin of each other never re-place on their own.

The strategies to start with, tried in this order, stopping at a certain match:

1. **Same span.** Its id is among the current file's spans → *attached* (score 1).
2. **Moved.** Its id is among another file's spans (ids don't depend on the file) → *moved* (0.95). The files looked
   in are the ones that differ from HEAD on disk: code moved to another file changed that file. Parses are cached, so
   each is parsed once.
3. **Re-identified.** Its baseline content is available (from git's objects, for code that was committed): follow
   the span's node through the structural diff `reidentify` uses (BABLR's `follow`). The diff compares a container
   by its type alone, so a container survives edits inside it — `fn(foo, bar, baz)` that became `fn(foo, bar, baz2)`,
   or a function whose whole body was rewritten, is still the same node. For the same reason, a call replaced by a
   different call is "the same" to it too, so the score weighs how much of the node's head (its first tokens — the
   callee and first arguments, the name and signature) survived: 0.6 for a node the diff kept, plus up to 0.35.
4. **Same shape.** Spans of the same type, scored by how many tokens they share with the recorded shape, whether the
   recorded neighbours still sit beside them, and how near they are to where it was. `fn(foo, bar, baz)` that became
   `fn(foo, bar, baz2)` has a new id, but the same type, 7 of 8 tokens and both neighbours: it re-places on its own.
5. **Lost.** Nothing scored at least `askAt` → *orphaned*, kept with its last known file and line.

Every resolution records which strategy placed the annotation and its score, so a wrong re-placement can be traced
to the strategy and threshold that made it. A corpus of edit cases (a file before and after, the span, where it
should land) scores any pipeline and policy against each other: how often each re-places correctly, wrongly, or asks.

Observed annotations use the first two strategies only, and a lost one is dropped as it fades.

An authored annotation found by strategies 2–4 is rewritten with its new span, shape, context, file and baseline by
the person who owns it (each person writes only their own files), so the next read finds it with strategy 1. Other
people's annotations resolve the same way on read, without being rewritten.

## When its place is lost

An orphaned authored annotation stays until someone decides:

- **Re-place**: select the code it belongs to and attach it there (`pickAnchor` turns the selection into a span).
- **Dismiss**: remove it. A dismissal is written as a tombstone line, so a branch merge that still has the old line
  doesn't bring it back.

The insights extension surfaces orphans the same way for every kind, with both actions, and shows *uncertain* ones
with a way to confirm or re-place them.

## Storage

Every collection follows the evidence's layout: `.silo/<collection>/<user>/<file>.jsonl`, one line per annotation,
sorted, `merge=union`, and folded on read by annotation id, the line updated last winning. A dismissal is a tombstone
line, folded the same way. Collections may partition further (evidence adds an environment).

## Who does what

- **silo** (`lib/util/silo`): the span reference and annotation line types, the fold with tombstones, the strategies
  that need only spans' shapes (1, 2, 4), the policy, and the resolver that runs a pipeline under a policy — all pure.
- **The editor's BABLR** (bablr.ts, the worker): spans of a text with their shapes and neighbours, references for
  ranges, and re-identification from a baseline (strategy 3), all from its cached parses. Extensions reach it through
  two commands, both batched — one call a file: `editor.annotations.refer(text, file, ranges)` and
  `editor.annotations.resolve(text, file, refs, { observed })`.
- **Editor core**: baseline contents from git's objects.
- **The insights extension**: what you see, including orphans and their two actions.

## Decisions

Decided 2026-10-04: every one as recommended (the **bold** option).

- **D1 · Where baselines come from.** **(a) git's objects only**: step 3 works for code that was committed, which is
  what other people can see too; (b) also keep baselines on this machine for uncommitted code.
- **D2 · What a similar match does.** **(a) attach as uncertain, shown with confirm and re-place**; (b) treat it as
  orphaned until confirmed. (Refined: a match scoring at or above the policy's `autoAt`, with no close second, re-places
  on its own; below that, it's uncertain.)
- **D3 · Where orphans show.** **(a) as diagnostics (Problems view) with code actions** for re-place and dismiss; (b) a
  view of their own; (c) both. (Information severity, not hint: VS Code leaves hints out of the Problems view.)
- **D4 · Healing.** **(a) the owner's annotation is rewritten when found by steps 2–4**; (b) never rewritten; always
  resolved on read.
- **D5 · Dismissal.** **(a) a tombstone line**, so merges can't resurrect it; (b) delete the line.

## Building it

1. **silo**: the span reference and annotation line types, the fold with tombstones, the strategies over shapes
   (1, 2, 4), the policy and the resolver, the `.silo/<collection>/<user>/<file>.jsonl` layout — pure, testable on its
   own — and the corpus of edit cases that scores a pipeline.
2. **Step 3**: the BABLR worker re-identifies a span from a baseline (`bablr.reidentify`, from cached parses), and core
   reads baseline contents from git's objects.
3. **Notes**, the first authored kind (extensions/notes): add a note to a selection, see it inline, keep it attached as
   code changes, and re-place or dismiss it when it's lost — orphans as diagnostics with code actions. Done. A note
   whose code moved to another file goes with it (a tombstone in the old file's notes, the note in the new one's) once
   that file is saved; someone else's note waits in Problems, pointing there, until its author next looks. A move
   that arrives committed (pulled) isn't a changed file, so it isn't looked for: that note is asked about.
4. **The rest move onto it**: the event sheet's anchors and the runtime evidence's span lookup use the same resolver
   (evidence keeps steps 1–2 and fading). Done: evidence resolves through silo's `OBSERVED` pipeline (same span, then
   moved), each observation an `observedRef` (its id alone); the event sheet's parts carry a `SpanRef`; and the two
   annotation commands replaced `editor.bablr.spans` and `editor.bablr.anchors`.

Later: **a typed strategy** — the span's inferred type and the runtime values seen there as signals for a match the
shape alone can't settle (designed in RUNTIME-EVIDENCE.md, "The typed strategy": a re-scorer of same-shape candidates).
It joins the pipeline as one more strategy; nothing else changes. How often
it's needed shows in practice: every annotation a strategy other than its own id found records which one, and its score.
