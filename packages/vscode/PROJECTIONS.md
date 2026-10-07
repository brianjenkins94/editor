# Projections

A program shown as something other than its text — and, later, edited that way. Written 2026-10-06, from a picture of
macOS Automator: a workflow as a column of action cards (*Get Selected Finder Items* → *Render PDF Pages as Images* →
*Move Finder Items*), each with its options, its results, typed values flowing from one to the next, Step and Run in
the toolbar, and a log with every action's duration. Not to build now: this records where the work since LIVE-VALUES.md
and RULES.md points, so it's on the roadmap.

## Why it's close

Almost every part of that window is something the editor already has, made for other reasons:

| Automator | here |
|---|---|
| The cards, top to bottom | A function's statements, from its BABLR tree — each with a durable identity (anchors.ts, SPAN-ANNOTATIONS.md), so a card stays itself through edits and reformats |
| A card's options | A call's arguments; the rule editor already draws an input from a schema (rule-editor.ts: a string a box, an `enum` a select, a list with − and +, a command line) |
| What flows between cards (*Files/Folders* → *PDF*) | The types a run observes at each range, which the tsserver plugin already shows |
| *Results* under a card | The notes margin's live values: what each line bound, per turn of a loop (LIVE-VALUES.md) |
| Step, Stop, Run | The tsval debugger — and back, which Automator can't |
| Record | Recording what a call returned, at its seam (RULES.md, slice 2) |
| The log, a duration per action | Runs, coverage and profiling, on spans (RUNTIME-EVIDENCE.md) |
| The action library | The rules catalog — targets, operators, actions — and, later, palette blocks promoted from a project's own functions |
| A card's settings saved with the workflow | Rules: `{ when, then }`, mocks and decisions, in the policy files |

What's missing is the projection itself: a view that lays a function out as cards over those, and — the harder half —
writes an edit to a card back as code.

## The model

- **The text is the truth; cards are a view of it.** A card is a statement (or a call worth a card); its options are
  its arguments; its results are the margin's values for it. Reading comes first (as the event sheet decided: strong
  reverse projection), writing after.
- **Interlocking, as Automator does it.** A card shows what it takes and gives — the types observed flowing through it —
  and a card dropped in is offered only where its input is satisfied. Statement order stays the control flow; the typed
  values are what connects (the event sheet's hybrid: imperative order, typed scope).
- **One editor for options.** A card's options are drawn from schemas, as rules' arguments are: the same renderer, the
  same visual design.
- **No black boxes.** A card from the library is a function in the same material — openable, ownable, re-buildable.
- **Not only games.** The event sheet is this loop wearing a game palette; a script, a server's routes, an app's state
  are other palettes over the same machinery.

## The first slice: cards in the margin (built)

Read-only, and not a view of its own: the cards are drawn in the notes margin, beside the code, around the lines they
stand for — the same column that already carries the file's values, notes and coverage, so a card's results are the
values already level with its lines.

- **A card is a step, not a statement.** Code is written in paragraphs: consecutive top-level statements with no blank
  line between them are one step; a `//` comment above a statement starts one and is its title; a function or class is
  a step of its own. Untitled, a step is named by what it starts and ends with (`country … total`).
- **What a card says**, on its bottom border (in the blank line between steps, clear of the values): its title, what it
  is (`2 statements`, `function`, `call`), and whether it ran — `ran`, `partly ran`, `didn't run`, or for a function
  `called 3×` / `not called` — read from coverage's marks on its lines. The types of what it declares are on hover.
- **Where it comes from:** the capabilities tsserver plugin's `_statements` request (each top-level statement's range,
  the comment above it, a title and detail, the types of what it declares) — the project's own checker; live-values.ts
  groups them into steps and hands the margin (pane.ts `showPane`'s `groups`) a card per step. The cursor in a step
  lights its card.

- **The run log** (2026-10-07), after the last card: the last debug run step by step — each step that ran, in the order
  it first did, its card's number and title, its share of the run's work, and any time it waited — under how the run
  ended. Work is the interpreter's steps (tsval's `profile`: per top-level statement, by where the code is — a
  function's card gets its body's work, wherever it's called from), not wall time, which a debugger inflates and varies;
  so it's the same every run, comparable between steps and runs. Waits are on the event loop's virtual clock (a timer's
  delay, counted to the statement whose code runs when it fires). It comes with the run's final coverage report
  (`profile`), placed on the lines its statements are on now as coverage's marks are.

- **The pane's views** (2026-10-07): the pane's first line is reserved — a line's padding above the editor's first
  line while a pane shows — for a strip of tabs, pinned as the code scrolls: *Margin* (the column as it is: values,
  notes, cards, the run log), and the projections to come, *Cards* and *Event sheet*, shown disabled until they're built
  (pane.ts `showPaneViews`; live-values.ts declares them). A projection is a view in that strip, not a third column: the
  code and the pane are already a line-for-line grid, its view zones the row sizer, and a third column would split the
  width and fight for the same zones.

Next: options edited on the card for a call's literal arguments (written back to the call); then a library to drag a
call in from; then interlocking.

## Open

- What a card is inside a longer function — its body's paragraphs as cards within the function's, or folded as code.
- How loops and branches look: Automator has none; the event sheet's rows and groups do.
