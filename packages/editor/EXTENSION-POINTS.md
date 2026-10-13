# Extension points

What another extension can plug into: the seams editor-contrib's template (`contrib/`) uses, and the ones it should be
able to. Started 2026-10-08, after editor-contrib showed that an extension point we don't use ourselves drifts: its
interpreter talked to the editor through DAP custom events while tsval went around them, straight to the hub — so the
run effects added that day reached the run ledger from tsval's runs only.

## The test

An extension point is real when **our own code goes through it**. Each one below has an internal user that moves onto it
(tsval, the margin, the event sheet, the rules view), so every run of the editor exercises what a contributed extension
relies on, and a change that breaks one breaks ours first. Where VS Code has the extension point (a debugger, a view, a
command, `contributes`), we use VS Code's — a documented contract, other people's code already written against it, and
what's contributed stays portable to the desktop (extension boundaries: the hub is core's; worker-pod is the bridge).
That's for VS Code augmentations; core's own runtime UI — the shell, previews, the prompt in a preview window — isn't
one.

What an extension author imports is one package, `packages/run-contract` (released like hub, on the site as
`packages/run-contract@latest.tgz`): the run contract's types, and the workspace runtime's (`./runtime`). Span references and pane views join it as they're
published — it's renamed `editor-api` then. editor-contrib depends on it; worker-pod and tsval import the same types.

## 1. The run contract — done

A debugger is a runtime: what it reports goes in the margin, the evidence and the run ledger (packages/run-contract):

- **Events:** `values` (as they come), `coverage` (as the run ends), `effects` (each gated call made, denied, skipped or
  given — the run's envelope), `ended` (a file's values go; how it ended short, marked), `ask` (a capability stop's
  question), `recorded` (a call's real result, for a rule to give back), `listening` (a service's port), `idle`
  (waiting, nothing to step from).
- **Requests:** `decide` (a capability stop's answer, with the policy from now on), `stdin`, `getCoverage`, and `pace`
  for a debugger with a virtual clock.
- **Configuration:** `__policy` (the policy its gated calls are decided by), `__runId` (its run), `__live` (a live run:
  no effects), `__startedBy: "terminal"` (its output printed there, its stdin read from there).

**Dogfooded:** tsval tells all of it through the contract; worker-pod's debug-events.ts reads every debugger's the one
way, capability-stops.ts says what each answer at a capability stop means, and debug-control.ts drives any session for
an agent with DAP's own requests. A debugger in another extension host (editor-contrib's) is followed by what VS Code
tells every host — no tracker sees it — so an agent doesn't see its output. The performance budgets held with tsval's
values going to the workbench and back.

## 2. The workspace runtime — done (2026-10-10)

What the contract can't carry: a debugger's worker reads the workspace synchronously (`require`, `readFileSync` —
zen-fs over a SharedArrayBuffer) and its servers answer the preview. **Any debugger may have it**, not just tsval — an
interpreter like editor-contrib's should be able to run real programs against the workspace.

**The extension point** (packages/run-contract's `./runtime`): `workspaceRuntime()` — `connect(name)`, a port for the
debugger's worker, and (for the editor's own debugger) the workspace's `buffer`. The worker calls `connectRuntime(port,
{ name, session })`, reads and writes the workspace through its `fs` (below), and answers the preview for a port its
program listens on with `serve(port, request => response)`; no subject names.
Underneath, the port is a link into the editor's hub, so the worker stays a realm of its own: its spans (each step, each
request its servers answer), its logs and each server's traffic (`server:<port>`) are the editor's to see. The
extension's own code never joins the hub; worker-pod stays the one bridge.

**Dogfooded:** tsval is an extension of its own (`extensions/tsval`), in the bridge's host, contributing the `tsval`
debugger: VS Code's API, the contract and this export, nothing else — its adapter drives its worker by messages of their
own. What Run means for any debugger moved to worker-pod (an app's file runs the app, a rule's process.argv and its
cases, the run's registration, its exit code from DAP's `exited`). On a desktop build the same interface is Node's own
`fs` and `net`.

**For editor-contrib too** (2026-10-11). An extension loaded from outside the editor runs in the web worker extension
host (contributed-extensions.ts — its code kept out of the workbench realm), and an extension's exports reach only its
own host — so the runtime is put in each host by core, not exported (below), and the template's interpreter runs in a
worker on it. What handing a port across hosts meets (measured 2026-10-10, Brave, the dev build):

- **The workspace's buffer would cross.** The web worker host's iframe is same-origin (`allow-same-origin`,
  `cross-origin-isolated`) and the host is cross-origin isolated (`SharedArrayBuffer` there). A `SharedArrayBuffer`
  posted from the workbench down a `MessagePort` to a worker that iframe made is the same memory both ways — a write
  on either side is read on the other. So synchronous reads and writes of the workspace come with a port.
- **An extension can't open the way itself.** VS Code blocks `postMessage` for that host's extensions (the global is
  replaced by one that only logs, and the prototype's is gone), so an extension can't send a port out. Core has to be in
  the worker before that: as the architecture probe is (its bootstrap runs first and posts a port up through the iframe,
  probes.ts). From there, a host's extensions
  share its global scope, and an extension posting to a worker of its own (tsval's way) isn't blocked.
- **`BroadcastChannel` is no way round:** it delivers a `SharedArrayBuffer` as `null`, even within one realm, and carries
  no ports.

### The runtime's files, through core (decided 2026-10-10)

A contributed debugger doesn't get the workspace's buffer: it's our storage format (patched zen-fs's SingleBuffer — a
second zen-fs mounting it can break the filesystem's structure, `.git` and `.silo` with it), and the bytes are below
everything the editor keeps around a file: an open editor's unsaved text, change events, the policy, the run's effects.
It gets **synchronous files through core** instead, each call answered by worker-pod:

- **The wire.** `connectRuntime(port, { name })` hands worker-pod a small `SharedArrayBuffer` of its own — a
  mailbox — once (`runtime.fs.attach`, over the runtime's hub link). After that a call is the worker writing its request
  into the mailbox and waiting on it (`Atomics.wait`); worker-pod, watching it (`Atomics.waitAsync`), makes the call and
  writes the answer back. No message a call; one connection (the port), as before. VS Code's TypeScript server on the
  web reads its files the same way. What doesn't fit the mailbox goes in pieces.
- **The calls** (`runtime.fs`): `readFile`, `writeFile`, `stat`, `readdir`, `mkdir`, `rm`, `rename` — `/workspace` paths,
  failing as node's do (`ENOENT`, `EACCES`, …). A read is an open editor's text when it's open, else what's on disk; a
  write is the workspace's (so editors, Source Control and watchers see it).
- **The gate.** A call is the program's unless it says it's the debugger's own load (`{ load: true }`: the program and
  what it imports, read-only). The program's are decided by the session's policy as tsval decides its own
  (`policyFor(session)`, "this run" answers included): allowed, skipped, or failing with `EACCES`; a live run makes no
  write. The session is the one the extension named to `connect(name, session)`, bound to the link — the worker, and
  the program in it, can't run under another. The gate protects the workspace from the *program*, uniformly, whichever
  debugger runs it — it isn't a wall against the extension, which has `vscode.workspace.fs` like any extension.
- **Effects, kept by core.** Each program call is counted among its run's effects as it's answered (run-effects.ts), so
  a debugger's `effects` event tells only what the editor didn't see — the requests and commands it made itself.
- **Reaching it from either host.** `workspaceRuntime()` (run-contract's `./runtime`) finds it where core put it: in the
  bridge's host, worker-pod's — the buffer included, for tsval, our own code built with the same zen-fs; in the web
  worker host, core's (runtime.worker.ts, loaded by core's bootstrap before VS Code's extension host, its ports going up
  core's port into that worker, workerPort.ts — the one the architecture probe reports over too) — no buffer. Its
  `connect(name, session)` gives a port either way.
- **One way to link it** (run-contract's `linkRuntime`), whichever host the port comes from — into the pod's hub or the
  workbench's: the editor names the worker `<name>#<instance>`, its own id (an answer goes to that worker alone, not to
  every worker of the name; the architecture view counts each as an instance of `<name>`), and the link carries only the
  runtime — the worker's log, architecture and metrics, its mailbox handed over, its servers' requests and answers. No
  other service of the editor's, tsval's worker's included.
- **tsval's program's calls too** (2026-10-11): its `fs` is almostnode's over runtime-vfs.ts (a VirtualFS whose
  workspace paths go through `runtime.fs`; others — temp files — stay in the worker's memory), so core is the one gate
  for every debugger's programs. tsval still stops and asks at a call (a debugger's job), and gives a rule's result in
  a call's place; core decides, makes and keeps the call. Its module loading stays on the buffer: never gated, and
  measured, a mailbox call costs ~0.5–0.7 ms (the read ~0.17 ms of it) and a run's loading makes 2 (a script) to 10
  (two local modules) calls — 32 for one package it couldn't find, hundreds with real packages, every live run again.

## 3. Span annotations — done (2026-10-10)

Placing something on code that survives edits and reformatting (SPAN-ANNOTATIONS.md): `editor.annotations.refer`,
`resolve` and `spans`, commands worker-pod registers.

**The extension point** (packages/run-contract's `./annotations`): `annotations(vscode.commands)` gives typed `spans`,
`refer` and `resolve`, and the contract is documented there — batch them (one call per text), what each status means
(`attached`, `moved`, `re-placed` — store its new `ref` —, `uncertain`, `orphaned`: lost, kept to be re-placed or
dismissed), how a lost reference is looked for before it's orphaned, and `undefined` without the editor. `SpanRef` and
`Resolution` are util/silo's, re-exported.

**Dogfooded:** notes, insights' evidence, tsval's placed rules, worker-pod's rule places and core's run anchors
(anchors.ts) all call through it — no extension calls the commands by hand.

## 4. Pane views (the Margin pane's tabs) — done (2026-10-12)

The pane beside every editor (components/monaco-vscode-api/pane.ts) has a strip of tabs on its first line. VS Code has no
API for anything like it. Today one consumer owns all of it: live-values.ts lists the tabs (Margin, and two disabled
placeholders, Cards and Event sheet — though the event sheet is an extension of its own) and draws every entry in the
Margin, whoever's it is:

| In the Margin today | Whose | How it gets there |
| --- | --- | --- |
| A run's values (rows of cells, a column per turn), `process.argv`'s input row, values dropped | worker-pod's run contract → core | the hub (`values.session.*`), placed by live-values.ts |
| A capability stop's question, its buttons, the rule and mock editors it opens | worker-pod → core | the hub (`capability.ask`) |
| A run's end (crashed, stopped) | worker-pod → core | the hub (`values.ended`) — a gutter mark |
| Coverage marks and how often each line ran; the run log | core (coverage.ts) | a function call (`showMarks`, `showProfile`) — since step 3 coverage's own view into the Margin (`coverage.paneView`) |
| Placed rules | the capabilities extension's rules → core | `rules.placed` — a gutter mark (since step 3: the capabilities extension's own view into the Margin, from `silo.rules.list`) |
| The program's steps, a card around each | core (tsserver's `_statements`) | computed in live-values.ts |
| Prose notes | nothing in production: the notes extension shows notes as comment threads; only a tour test feeds the Margin's (`__pane.show`) | |

The pane's frame already takes data apart from DOM in one place — what goes where (entries on spans, groups, marks) is
data; only an entry's *inside* is DOM, rendered by a function its one consumer hands it. The extension point makes the
inside data too, and lets anyone hand it.

### The extension point

**A view** is declared in an extension's manifest — `contributes.paneViews` (VS Code ignores keys it doesn't know; core
reads the manifests it registers, built-in and contributed alike):

```json
"paneViews": [{ "id": "eventSheet", "label": "Event sheet", "title": "The program's conditions and actions" }]
```

and provided by a command, `<id>.paneView` (`eventSheet.paneView`), which core runs for a file — when its view is shown,
the file is, or the file changes — and which answers with what to draw:

```ts
interface PaneContent {
	entries: PaneItem[];      // beside the code, each level with its lines
	groups?: PaneGroup[];     // cards drawn around spans of lines (the steps)
	marks?: PaneMark[];       // the gutter column, left of the code (coverage, a run's end, placed rules)
}
```

A provider tells core its content changed with the command `editor.pane.refresh(view, uri?)` — commands cross extension
hosts, so a provider can be in any of them, the web worker host's (editor-contrib's) included.

**Where an item is** — `at`, one of three, and core turns each into the lines it's on *now*:

- `{ lines: [from, to] }` — 0-based, in the document as it is (the provider follows its code itself);
- `{ ref: SpanRef }` — a span reference (`annotations.refer`'s): core resolves it, so it follows its code through edits,
  reformats and moves as notes and evidence do — and a lost one isn't drawn;
- `{ ran: { source, start, end } }` — an offset range in a text that ran (what a debugger reports): core refers it once,
  against that text, and resolves it as the file changes (anchors.ts) — how values, the question and a run's end are
  placed today.

Providers never compute lines from a text that ran themselves; the one way to place things on code is core's
(*tolerate cosmetic formatting*).

**What an item is** — data, drawn by core in the pane's one look:

```ts
interface PaneItem {
	id: string;
	at: At;
	content:
		| { markdown: string }                                    // prose: a question, a hint (sanitized, VS Code's renderer)
		| { label?: string; lead?: PaneCell[]; value?: PaneCell; cells: PaneCell[] }  // a row: a picker, a label, the line's value, a turn each
		| { label: string; input: { value: string; placeholder?: string; submit: Command } };  // one line typed in
	actions?: Action[];       // buttons under it (Allow ▾, Skip ▾, Deny ▾, Rule…) — at a row's end, on hover (Mock…)
	tone?: "info" | "question" | "warning" | "error";
}
type Action = Command & { more?: Command[] };                 // ▾: the ways it can go (this call, this run, always)
interface PaneCell { text: string; kind?: "number" | "string" | "boolean" | "object" | "error" | "undefined" | "branch" | "set" | "skip" | "given"; title?: string; command?: Command; picked?: boolean }
interface PaneGroup { id: string; at: At; label: string; detail?: string; title?: string; state?: "ran" | "partial" | "missed"; stateText?: string }   // a step's card, and how it ran
interface PaneMark { at: At; kind: "ran" | "partial" | "missed" | "crashed" | "stopped" | "rule" | "rule-uncertain"; title?: string }
// Command: VS Code's own shape — { title, command, arguments?, tooltip? } — and disabled?, shown but not offered
```

Rows in a run of consecutive lines align their cells into columns (a turn of a loop each), as the Margin's do now;
hovering a cell marks what it's about; a cell's `command` runs on click (picking a turn). Data, not DOM, because a
pane view's rows sit level with the code and move with it (view zones, wrapping), which a webview can't follow; and the
pane stays one look, whoever's view it is.

**Into the Margin.** A provider can also contribute *into* an existing view rather than a tab of its own —
`"paneViews": [{ "id": "notes", "into": "margin" }]` — its items drawn among the others, on their lines. That's how notes,
coverage and editor-contrib's interpreter add to the Margin without owning it.

**Natively** (6: a desktop build has no pane), the same content is drawn with VS Code's own contribution points: a row's
latest cell as an inlay hint at the end of its line (and an inline value at a stop, as now); markdown as a hover on its
span; actions and a group's label as CodeLens above their lines; marks as gutter and overview-ruler decorations. Data is
what makes the second face possible.

### Proposed, for deciding

1. **The rich editors leave the Margin.** The rule and mock editors a question's Rule… and Mock… open, and a variable's
   mock, open in the Rule view under the Rules tree (where a rule is already edited), not inline. A view's items stay
   data (markdown, rows, one-line input, buttons), and the Margin's buttons become commands that open them there.
2. **Notes keep their comment threads.** The notes extension's comment threads are how notes look in the editor (our
   resolver placing each, VS Code drawing it); the Margin doesn't draw notes. The tour test's `__pane.show` and the
   Margin's note rendering (pane.tsx) go.
3. **Core places everything** (`at`'s three forms above): no provider computes lines from a text that ran.

### Steps

1. ~~**The content model and core's renderer**~~ — done (2026-10-12): run-contract's `./pane` (the types,
   `refreshPane`); core's pane-views.ts — the strip (core's views, then every extension's `contributes.paneViews`, read
   through VS Code's extension service, whichever host), a view's provider asked per shown file, each item's `at`
   resolved, its content drawn in the Margin's look; the Margin still live-values.ts's drawing, handed to pane-views
   (`showMargin`) with what's `into` it. Proved by an extension from outside the editor (test/pane-views.mjs and its
   fixture): its tab, each item kind and placement, followed through an edit, its button and input.
2. ~~**The Margin becomes the first provider**~~ — done (2026-10-12): the rule and mock editors (Rule…, Mock… on
   process.argv and on a variable) open in the Rule view (rules-view.ts's `editInRuleView`); live-values.ts answers
   `margin.paneView` with its values, the question, a run's end, the run log and the steps' cards as data — each placed
   by its range in the text that ran — and its buttons and cells run `margin.*` commands (decide, rule, mockArgv,
   mockVariable, pick, hold). It keeps the hub side (sessions, anchors) and margin.state. The contract grew what the
   Margin needed: a row's lead cells and own value, an action's menu, disabled actions, a card's detail, title and
   state text. The Margin's prose notes went (decided: notes are the notes extension's comment threads).
3. ~~**Coverage contributes into the Margin**~~ — done (2026-10-12): coverage.ts answers `coverage.paneView` (core
   declares it into the Margin), and the capabilities extension `placedRules.paneView` (its manifest's
   `"into": "margin"`) from `silo.rules.list` — whose, sentence, lines and how sure, as the editor found each; the hub's
   `rules.placed` went. The Margin keeps coverage's marks only to say how each card ran; margin.state lists coverage and
   the run's end (placed rules are rules_list's).
4. ~~**The event sheet takes its tab**~~ — done (2026-10-12): the event-sheet extension declares `eventSheet` (its
   manifest's `paneViews`, activated on `onCommand:eventSheet.paneView`) and answers it with the open file's part of its
   game — each rule a card around its function (what it's for each of), each condition → action on its `if`, each
   object, behavior and composite behavior on its declaration — placed by the span references anchoring gives them; the
   game's projection is cached until one of its files is saved. Its map and builder stay the webview view they are.
   Core's placeholder tabs (Cards, Event sheet) went; Cards waits for the cards projection (PROJECTIONS.md). A view with
   nothing for a file keeps its pane, so its tabs stay to switch back.
5. ~~**The native face**~~ — done (2026-10-12): pane-native.ts draws the shown view's content with VS Code's own
   contribution points, the pane hidden — a row as an inlay hint (its label and latest value, every cell on hover),
   prose as a CodeLens (its first line) and a hover (whole), buttons as CodeLenses (a menu's ways in a quick pick), an
   input as a CodeLens asking for it, a card as a CodeLens above it, a mark in the overview ruler. *Pane: Toggle Pane /
   VS Code Annotations* switches (remembered), *Pane: Show View…* picks the view with no tabs to pick it. Public API
   only: what a desktop build would draw. At a stop the values show twice (VS Code's inline values too).

## 6. VS Code's own contribution points

Where VS Code has a contract for what we built ourselves, we move onto it — the run contract's lesson, applied to the UI
the extensions add. monaco-vscode-api implements each API below; the comments and testing services are on in our
workbench, the chat service isn't.

| Ours | VS Code's | Decision |
| --- | --- | --- |
| The Rules view (core UI) | A tree view (`contributes.views`, a TreeDataProvider, inline actions) | **Moved** (2026-10-10): the capabilities extension's tree (rules-tree.ts) beside Capability calls — Yours / Shared, a rule's sentence and its line, Remove and Re-place at selection inline, New Rule in its title — from the editor's commands (`silo.rules.list`, `.open`, `.new`, `.remove`, `.replace`). The rule editor stays ours, in the Rule view under it — nothing native edits predicates |
| Live values at a stop | `InlineValuesProvider`, the debugger's own contract for values beside the code | **Added** (2026-10-10, live-values.ts): at a stop, each line's latest value at its end, on the line its code is on now — the margin's values, for the session whose frame is in focus, whichever debugger's. Answered once the stop's values are in (they come by the hub; VS Code asks as it stops, and doesn't ask again when they change) |
| Margin entries — the question, a run's end, coverage counts | CodeLens, inlay hints, decorations | **Later, with 4 and 5:** entries as data, drawn richly by the pane and natively by these — the margin's desktop face |
| Agent tools (page-tools.ts, every tool in one place) | `contributes.languageModelTools`, `vscode.lm.registerTool` | **Not adopted:** those are tools for an agent inside VS Code — its chat — and VS Code isn't an MCP server that hands them to one outside. Our agent is outside: debug-mcp reaches the tab over the hub. A contributed tool would connect nothing we have |
| Notes | The Comments API | **Adopted, as the display only.** The notes extension draws each note as a comment thread (`vscode.comments`), our resolver placing it on its span each time the file is shown or changes — VS Code keeps nothing and follows nothing past typing, so the span anchors stay the truth. A lost note waits in Problems. The Margin needn't draw notes too (4, proposed) |
| Coverage marks | `TestController` with `FileCoverage` | **Not adopted:** the beaker and TestController were removed by choice, for ambient marks of our own |

Already VS Code's: Source Control, tasks, diagnostics, configuration, debuggers; the terminal speaks shell integration.

## 7. The capability decider

decide.ts asks the policy, then the user (the prompt in the preview window). The decider is the seam: a contributed
decider — an AI, an elicitation, a team's or CI's policy — answers instead, and the prompt is the default one.

## A desktop build

What a desktop VS Code extension of this would meet, as the code stands: the feature extensions are hub-free and run as
they are (but `editor.annotations.*`, which core's BABLR answers); the run contract's layer is DAP and public API. What
breaks is what worker-pod reaches over the hub, because core isn't there:

- **The workspace runtime** → Node's `fs` and `net` (2's interface); tsval's worker → `worker_threads`.
- **Core's services that are just code** — the run registry, the evidence and run ledger, BABLR's spans, the edit
  history, git → moved into an extension (git: VS Code's own).
- **Core's UI** — the margin, the Rules view → 6's native renderings (the Rules view is a tree view already; every pane
  view's content has its native face, pane-native.ts); the margin's pane itself has no counterpart.
- **The browser runtime** — previews and their dev servers, the service worker's gate, just-bash, isomorphic-git →
  dropped for the real thing (Simple Browser, the terminal, git).
- **Agent tools** → `languageModelTools` or an MCP server.

## Later

- **Evidence languages:** a BABLR grammar as a package, so a file in another language gets spans, and evidence.
- **Preview frameworks:** almostnode's `frameworks/` (Vite today) as adapters.

## Order

1. ~~The run contract, editor-contrib onto it, tsval through it; the gated call's round trip; terminal runs and agent
   control through it~~ — done (2026-10-08 → 10).
2. ~~The workspace runtime; tsval its own extension (2)~~ — done (2026-10-10).
3. ~~The Rules view as a tree view; inline values (6)~~ — done (2026-10-10).
4. ~~Workspace tools for an agent (below), so one develops in the workspace as on a local machine~~ — done (2026-10-10).
5. Pane views (4): the content model and core's renderer; the Margin as the first provider, coverage and placed rules
   into it, the event sheet's tab; then the native face.
6. The decider — when a second decider needs it.

## Workspace tools — done (2026-10-10)

debug-mcp's tools watched and debugged — the editor, problems, runs, previews, the debugger, the margin — but an agent
couldn't do the work itself, as it would on a local machine. Now it can (workspace-tools.ts, git-service.ts; the page
tools in page-tools.ts):

- `files_read`: a file numbered as `cat -n` does — what's open in an editor (unsaved edits included), else what's on
  disk; `files_write` and `files_edit` (an exact string, once or every time): as a `WorkspaceEdit`, so an open editor,
  undo, the edit history and format on save see it as typing, then saved;
- `files_glob` (`findFiles`) and `files_grep` (a regular expression, line by line);
- `shell`: a command line in core's just-bash, as the terminal runs it (`node` in the debugger, `npm`), its output and
  exit code — each call its own shell;
- `git`: status, a unified diff of the working tree against the last commit (jsdiff's — the `diff` package, already
  bundled for just-bash — in git's format), commit. isomorphic-git has no text diff of its own.
