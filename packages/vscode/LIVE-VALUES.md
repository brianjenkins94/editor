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
   inputs from Run with Inputs' remembered ones when its launch config gives none.
3. **The overlay in the component**: a strip, rows by line, columns by iteration, from data it's given; its own test
   page.
4. **Core between them**: the latest session's record per file, the cursor and the pointer back from the overlay.
5. **A tour test**: a session over a binary search, the panel's rows and columns read back.
6. **Capability decisions on the line**: a capability stop's *Allow once* / *Allow always* / *Deny* on its line, the
   choice resuming the run.
