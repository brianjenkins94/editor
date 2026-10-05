# Live values

What the code did, beside the code: for each line, the values it computed, a column per time it ran — the right-hand
side of Bret Victor's *Inventing on Principle* binary search. You read the code on the left and see, line by line, what
it was in this run: `mid = 2 | 4 | 3`, `value = 'c' | 'e' | 'd'`, `return 3`.

```
 function binarySearch(key, array) {   │ key = 'd'   array = ['a','b','c','d','e','f']
   let low = 0;                        │ low  = 0
   let high = array.length - 1;        │ high = 5
   while (true) {                      │
     const mid = Math.floor(...);      │ mid  =  2  │  4  │  3
     const value = array[mid];         │ value= 'c' │ 'e' │ 'd'
     if (value < key) {                │
       low = mid + 1;                  │ low  =  3  │     │
     } else if (value > key) {         │
       high = mid - 1;                 │ high =     │  3  │
     } else {                          │
       return mid;                     │ return     │     │  3
```

## What's there to build on

- **tsval** runs a debugged program statement by statement, its effects inert (`fetch` and node's builtins are stand-ins:
  capabilities/canary.ts), so running code to see what it does is safe.
- **Its `observe` hook** reports real values, but only at five kinds of site — `?.`, `??`, a branch, a parameter, a
  return — and not which call or loop iteration a value belongs to. Nothing fires for a declaration or an assignment.
- **The debug worker** keeps a full copy of the machine at each stop (time travel), not at each statement, and nothing
  reads that history out. Runtime evidence keeps counts and at most five sample values per site, unordered.

So the panel needs the values themselves, in order, each placed by line, call and iteration: nothing records that yet.

## Settled

Decided 2026-10-05.

- **It's an overlay in the editor.** Monaco places HTML of its own in the editor's coordinates — the minimap, the find
  widget, a diff's inline zones are drawn that way — so a strip on the editor's right, reserved the way the minimap
  reserves its own, can draw a row beside each line, scroll with the code, and be more than text: one iteration's
  column lit across every line when hovered, values colored by kind, an array opened under the cursor. VS Code's
  extension API has nothing like it, so it lives in the component (components/monaco-vscode-api, where the workbench is
  composed, beside the hosted editors and the live architecture pane), on `ICodeEditorService`, and is fed what to
  draw; it knows nothing of debuggers.
- **Its values come from a debug session, and live only as long as it does.** While a tsval session runs, the debug
  worker records each statement's values as it executes them; the panel shows them as they come, the whole run once it
  ends or pauses, and nothing when the session is gone. No new store, no format in `.silo/`: runtime evidence stays
  what keeps runs, and this is what a session shows.
- **It's started by F5 and a breakpoint**: an ordinary tsval debug session. Not a re-run as you type, for now.
- **Inputs are pipe-delimited, for now**, as Run with Inputs takes them (`US | CA | FR SPRING10`: runs by `|`, a run's
  arguments by spaces, read as `process.argv`). A session runs one set: the launch config's `args`, or the first of the
  inputs Run with Inputs remembers for the file. A function the program doesn't call, or calls differently than you
  want to see, waits for the inputs design (RUNTIME-EVIDENCE.md, the fourth slice).

## How it fits

```
debug worker ──(records, in memory)──▶ debug adapter ──pod hub──▶ workbench (core) ──▶ the overlay (component)
                                        worker-pod                 live-values.ts        registerLiveValues
```

- **The debug worker** records as it runs (the next section), and hands the adapter what's new — batched, a few times a
  second, and all of it when the run pauses or ends.
- **The debug adapter** (worker-pod) passes it on over the pod hub: `values.session.<id>` as it grows, `values.ended`
  when the session ends. worker-pod stays the only bridge between extensions and core.
- **Core** keeps the latest session's record per file and tells the overlay what to draw for the editor showing it:
  rows by line, columns by iteration, the selection.
- **The component** draws it, and says what the cursor and the pointer are on (a line, a column), so core can expand
  the line under the cursor and light a column across lines.

## The record

Per statement executed, in a session: its line, the names it bound and their values — a declaration's, an assignment's,
a `for`'s variable, a parameter on entry — a `return`'s value, and a condition's outcome. Each entry knows its call
(the frame it ran in, numbered as calls are made) and, inside loops, its iteration of each loop around it. Columns are
iterations of the innermost loop around the line; a call is a set of columns of its own, and the panel shows one call
of a function at a time (the latest, or the one picked).

That's tsval's to provide: `observe` firing for declarations, assignments, loop variables and parameters, with the
step, the frame and the loop iteration — a trace mode, off unless the session asks.

Bounded, because a session can run forever: a value is kept as the debugger's Variables view shows it (a short
preview, an array's first items), a loop's first N iterations and its last few, and each line's first N calls. The
bounds are the panel's to state ("… 980 more").

## The overlay

- The strip is as wide as the editor allows past its longest line, a divider at its left edge; values in a monospace,
  each column as wide as its widest value.
- **The cursor** decides what's shown: the function around it, and its line opened up — every iteration, full values.
- **Hovering a column** lights that iteration on every line; clicking it holds it.
- Lines with nothing to show (a `{`, a comment) are blank; a line that never ran in the call shown is dimmed.

## Spike: Code Hike inside Monaco

Code Hike (already the review panel's diff renderer: git-codehike.tsx) is two halves. **Data**: `highlight()` gives
shiki's tokens and the annotations — a *block* (lines `from`–`to`) or an *inline* (columns on a line), each with a
`query` and `data` — read from `// !name(query)` comments or given directly. **Rendering**: `<Pre>` groups lines by block
annotations and builds React through a stack of handlers, each able to wrap the `Pre`, a `Block` of lines, a `Line` /
`AnnotatedLine`, an `Inline` range or a `Token`, calling `InnerLine`/`InnerToken` to go on — which is why handlers
compose, and what its recipes (mark, focus, callout, tooltip, fold, diff, transitions) are built from.

It can render inside Monaco (spike-codehike.tsx, `globalThis.__spikeCodeHike(uri, annotations)`): `<Pre>` in an overlay
widget over the editor's text area, in its font, line height and tab size, moved with its scroll; Monaco's own glyphs
transparent, so what's seen is Code Hike's rendering of the same text while Monaco keeps editing, the cursor, the
selection, word highlights and bracket matching — all aligned. A handler that adds height (a callout under a line) gets
a Monaco view zone as tall, under the same line, so every line below stays aligned. Tried on the binary search: `mark`
on the loop's two lines, a callout under `mid` (`2 | 4 | 3`) and under `value` (`'c' | 'e' | 'd'`), typing on a line
above them — Code Hike re-renders, the cursor lands where Monaco puts it.

What it showed:

- **Annotations must be given, not written.** Code Hike strips `// !` comments, which would put its lines out of step
  with Monaco's; live values make annotations anyway.
- **Columns are drawn, not counted.** Code Hike counts a tab as one column; a callout points at a token's middle as
  drawn (tabs expanded to the editor's tab size).
- **Anything Monaco inserts into a line breaks alignment there**: inlay hints, inline suggestions, injected text, word
  wrap, folding (hidden areas). Each wants turning off while the overlay is on, or bringing into Code Hike (an inlay
  hint as a token).
- **Use Monaco's tokens, not shiki's.** `<Pre>` takes any tokens: built from Monaco's tokenization, the colors are the
  editor theme's (shiki's github-light isn't), nothing is fetched (shiki loads grammars from lighter.codehike.org), and
  re-rendering on each keystroke is synchronous instead of an async highlight.
- **Render what's visible.** The spike renders the whole file; a long one wants the visible lines only, offset.
- **A handler that adds height says how much**, so its view zone can be made first: the spike fixes a callout at two
  lines.

So the values can be Code Hike annotations — a callout of each turn's value under its variable, `mark`/`focus` on the
lines a picked turn ran, a tooltip with a whole value, transitions to scrub through a run — rendered in the editor, not a
pane beside it. The strip (step 3) stays the table of every line's turns; which reads better beside the code is for
trying both on real runs.

## Revised: the right-hand side is notes, rendered with Code Hike

Decided 2026-10-05, after the spike: not Code Hike drawn over Monaco's text, but a right-hand side beside it — literate
programming, explanatory prose beside the code it explains — and Victor's values are the same thing: notes. One
pane, one kind of anchor, the machinery we have.

- **The prose is notes** (extensions/notes): Markdown on a BABLR span, in `.silo/notes/<author>/<file>.jsonl`, placed
  each time the file is shown or changes through `editor.annotations.resolve`, so it follows its code through edits
  and moves. The pane shows each note beside its span's first line; writing one stays the notes extension's
  (`notes.add` on a selection, its comment thread to edit, reply or dismiss).
- **The values are notes too**: a debug session's record (step 2) becomes annotations of a kind of their own
  (`values`), each line's values on the span of the statement that bound them — referred to with
  `editor.annotations.refer`, placed with `resolve` like any note, so a session's values stay on their code as it's
  edited. Kept in memory for the session, as settled above: never written to `.silo/notes`.
- **Code Hike renders the pane**, in the editor's tokens: a note's prose, its inline code and code blocks highlighted;
  a values note as Victor's columns (each turn a column, a picked turn lit across lines). The links run both ways —
  hovering a note marks its span in the editor (a Monaco decoration, Code Hike's hover recipe), the cursor on a line
  lights its note.
- **The strip from step 3 becomes the pane's frame**: placed beside the code, scrolling with it, an entry per anchored
  line; the component draws the frame and hands each entry's element to core, which renders Code Hike into it.

What the changes pane already does with Code Hike (git-codehike.tsx), and what carries over:

- It uses `highlight()` (shiki's github-light/dark, by the OS's scheme, grammars from lighter.codehike.org) and two
  handler slots for layout — a `Pre` of `display: contents`, so lines join an outer grid, and a `Line` placing each line
  as a subgrid row (fold chevron, commit pick, number, code, Code Hike's hanging-indent wrap). It uses no annotations:
  its spotlight is a `highlightedLines` set, its folds computed from token colors.
- **Carried over**: the lazy React island (`mountDiff(host, input)`, one root per host, loaded on first use), the
  light/dark theme, and the cross-surface hover link — `setDiffHighlight`, the changes list's chunk hover spotlighting
  the diff's lines, generalized into the store both directions of note ↔ code use.
- **Done differently**: the notes pane uses Code Hike's annotations proper — `mark`, `focus`, callouts, tooltips as
  annotation objects — for the code in notes and the values columns. (The changes pane's spotlight and folds could
  move onto them later.) Code inside a note isn't in Monaco, so it's shiki's tokens there, as the changes pane's.

**The grid, across the editor and the pane.** The changes pane keeps its two sides in one CSS grid, so a row is as tall
as its taller cell; here one side is Monaco, which sizes its own lines, so Monaco is the grid's row sizer and its view
zones are how the code side grows. Each note's cell spans its span's rows (its first line to its last), placed from
`getTopForLineNumber` (which counts zones, so the pane and the code can't drift); a note taller than its span gets a view
zone after the span's last line as tall as the difference — the code below moves down by that much, the pane leaves
the same gap — so a multi-line note never spills onto lines it isn't about. Notes on overlapping spans stack in one
cell, the zone tall enough for them all.

How it fits, reusing the bridge: the notes extension sends its placed notes to core through a worker-pod command
(`editor.pane.notes`, per file), the debug adapter its session's values (already on the pod hub); core renders both into
the component's frame.

## Capability decisions, on the line

A capability breakpoint (extensions/capabilities: a call the policy hasn't decided — a write, a fetch, a spawn — hard-
stops the run at its line) asks today in a prompt away from the code: *Allow once*, *Allow always*, *Deny*
(capabilities/decide.ts). Stopped there, the overlay is already beside that very line: the decision goes there, as
buttons on the line that provoked it, with what it would do — the resource, from the run's own values (`writeFile
'/workspace/out.txt'`) — next to them. A choice resumes the run; *Allow always* writes the user's policy override, as
the prompt's does now; the prompt stays for runs nobody's debugging (a preview, a script without a session). Another
consumer of the same strip: the overlay draws what core gives it, values or a decision.

## Open

- **Live, later.** The file re-run in a session as you type (when typing pauses) is Victor's immediate connection;
  tsval is safe to re-run, and the capabilities plugin already re-runs a file on every edit. It waits on the panel
  working from F5.
- **The bounds**, and how many calls the panel lets you pick between.
- **Previews.** A preview's code runs instrumented in the page, not under tsval: none of this, for now.

## Building it

1. **The trace in tsval**: `observe` for declarations, assignments, loop variables and parameters, with step, frame and
   iteration; tested in tsval's own suite. Done: a `trace` option of its own beside `observe` (which runtime evidence
   keys by node, one site each), off unless asked — each value a declaration, an assignment (`=`, `op=`, `++`; a member
   target as written), a destructuring (each name), a `for…of`/`for…in` variable or a parameter bound, each `return`'s,
   each `if`'s arm; with the step, the call (numbered as calls are made, 0 the top level) and each loop around it in that
   call with its turn, read off the frame stack (a loop counts its turns as it starts its body, so a `for`'s
   incrementor counts in the turn it ends). The binary search traces as the talk shows it (test/vm/trace.test.ts).
   Not yet: a parameter with a default or a pattern, a `for…of` destructuring its element.
2. **The record in the debug worker**, bounded, handed to the adapter, and on to core over the pod hub; a session's
   inputs from Run with Inputs' remembered ones when its launch config gives none. Done: tsval's trace tells each
   value's callee too; the debug worker keeps a session's values in a `LiveRecord` (extensions/worker-pod/
   live-values.ts, pure, tested) — each a preview as code writes it (`'d'`, `['a', 'b', …]`, own data properties only,
   never a getter), its line, call and turns; a call named by its function once; at most 50 turns of a loop, 2000
   values a call and 200 calls, the rest counted as dropped; a replay after stepping back not told twice — and tells
   the adapter what's new four times a second and before each stop and the end. The adapter publishes it on the pod hub
   as `values.session.<id>` (with the file) and `values.ended`. A launch without `args` takes the first set of the
   file's remembered inputs. Seen in the editor: a session over the binary search, every value in its turn.
3. **The overlay in the component**: a strip, rows by line, columns by iteration, from data it's given; its own test
   page. Done: `showLiveValues(uri, view)` (components/monaco-vscode-api/live-values.ts) draws a view — rows of a label
   and a value, or a cell per column — beside every editor showing the file, now and when one opens it, through
   `ICodeEditorService` and an overlay widget per editor; the strip starts past the file's longest line when there's
   room (240px at least), each row placed by its line as the editor scrolls and lays out, labels right-aligned, each
   column as wide as its widest value (24 characters at most, a value cut short with an ellipsis), values colored as the
   debugger colors them. Hovering a column lights it on every row, a click holds it; the cursor's row opens up. No test
   page: drawn from a script in the editor (`globalThis.__liveValues`, for a console and the tour) instead.
4. **Core between them**: the latest session's record per file, the cursor and the pointer back from the overlay.
   Revised (above): the frame hands each entry's element to core; core renders the pane with Code Hike. Done: the
   component's `showPane(uri, entries, render)` (pane.ts) puts a cell beside each entry's span, entries on overlapping
   spans stacked in one, and hands each entry's element to `render`; Monaco is the row sizer — a cell taller than its
   span gets a view zone after the span's last line for the difference, resized as the cell's content settles
   (a ResizeObserver: a code block highlights after the prose); the pane takes the editor's line height, so a one-line
   note is exactly its line. Hovering an entry marks its span (a whole-line decoration); the cursor's cell is lit.
   The pane is an overlay inside the editor, not an editor group of its own: one scroll, nothing to synchronize. Its
   left edge is a divider you drag (remembered, the same for every editor; by default past the longest line, at most
   60% of the way). Wrapping wraps at the divider: while a pane shows, the editor wraps `"bounded"` at the divider's
   column, and Alt+Z (whose override knows only "wrap at the full width", which would put code under the pane) is
   taken over for an editor with a pane to toggle wrapping at the divider; elsewhere it is VS Code's. A cell's span is
   measured to its last line's bottom, so wrapped rows count.
   Core's `renderNote` (pane.tsx, loaded on first use) renders a note's Markdown with VS Code's own renderer
   (sanitized; the component's `renderMarkdown`) and its code blocks with Code Hike (`highlight` + `<Pre>`, the GitHub
   theme for the workbench's light or dark). A script can show notes (`globalThis.__pane.show`) until the notes
   extension does (step 5).
5. **Notes in the pane**: the notes extension sends its placed notes (`editor.pane.notes`); their prose beside their
   spans, rendered with Code Hike; hover links both ways.
6. **Values as notes**: a session's values referred to their statements' spans, placed like notes, rendered as Victor's
   columns in the same pane.
   Done, placed by line (not yet referred to spans): core's live-values.ts follows `values.session.*` and
   `values.ended` on the workbench hub, keeps the latest session per file, and draws it in the notes margin beside the
   prose (`showNotes`; both in one `showPane` per file) — a row per line that has values, its label (`mid =`,
   `return`, `if`) then a cell per turn of the loop around it: every line at the same depth in a call has the same
   columns, each as wide as its widest value, so a turn reads straight down, and hovering one lights it down the call;
   a line outside a loop shows its value once, a line binding several names (parameters) names each; an `if` shows
   the arm it took. A function called more than once shows its latest call. The values go when the session ends or is
   stopped (the adapter now says so on a stop too). Seen in Brave over the binary search, paused on `return mid`.
   Then the rest of the overlay's design: a function called more than once has a picker on its first line
   (`‹ 7/9 ›`: the latest call unless one's picked, so a running session follows new calls); a click holds a column lit
   down its call; the cursor's line opens up, each value whole and wrapped in its column, the margin's cell growing for
   it (the component lights the cursor's cell); what the bounds left out is said under the last line ("… 20 more values
   not kept"). Seen in Brave over a recursive `fib`, a long object and a 60-turn loop.
   Not yet: values on spans (so an edit mid-session doesn't misplace them) — waits for values that outlive a session.
7. **A tour test**: a note and a session over the binary search, read back from the pane.
   Done (test/architecture-tour.mjs, "live values"): the talk's binary search with a prose note on its first line, a
   session paused on `return mid`; each values row read back by its line — the parameters named, `mid` and `value`
   a column per turn, each `if`'s arm, `low` and `high` only in the turn that set them — and the note beside them;
   stopped, the values go and the note stays. It leaves the workbench as it found it: a breakpoint's stop puts the
   Run and Debug view where the Explorer was, which the tests after it open files from.
8. **Capability decisions on the line**: a capability stop's *Allow once* / *Allow always* / *Deny* on its line, the
   choice resuming the run.
   Done: at a capability stop the debug worker finds the call on the line the policy gates and the resource it would
   reach — a literal, or a variable's value; the argument as written when it's only known once the line runs — and
   sends it with the stop (`ask`); the adapter publishes it (`capability.ask`, cleared when the run resumes, however it
   resumes) and serves the choice (`debug.session.<id>.decide`). Core draws it in the margin on its line, first in its
   cell: `writeFileSync '/workspace/out.txt' fs:write`, then the three buttons, the choice sent back. *Allow once* lets
   the call run (and stops there again next time); *Deny* makes it fail as a denied call would (`EACCES`, from the
   stand-in); *Allow always* writes my override (`.silo/<me>.policy.json`, as the preview's prompt does) and hands the
   worker the policy now in effect — offered only when the resource is known, since a rule needs one. A capability
   line is armed from the source alone (a literal resource, or none), so a stop now checks the call's actual resource
   against the policy and goes on when it's allowed: an *Allow always* on a variable's value holds on the next run. And
   the worker's breakpoint updates no longer drop the capability lines (they replaced every breakpoint with the
   user's). The tour test runs all three (test/architecture-tour.mjs, "capability decisions").
