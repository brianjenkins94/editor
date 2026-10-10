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

**The extension point** (packages/run-contract's `./runtime`): worker-pod's exports give `workspaceRuntime()` — the
workspace's `buffer`, and `connect()`, a port for the debugger's worker. The worker calls `connectRuntime(port, { name })`
and answers the preview for a port its program listens on with `serve(port, request => response)`; no subject names.
Underneath, the port is a link into the editor's hub, so the worker stays a realm of its own: its spans (each step, each
request its servers answer), its logs and each server's traffic (`server:<port>`) are the editor's to see. The
extension's own code never joins the hub; worker-pod stays the one bridge.

**Dogfooded:** tsval is an extension of its own (`extensions/tsval`), in the bridge's host, contributing the `tsval`
debugger: VS Code's API, the contract and this export, nothing else — its adapter drives its worker by messages of their
own. What Run means for any debugger moved to worker-pod (an app's file runs the app, a rule's process.argv and its
cases, the run's registration, its exit code from DAP's `exited`). On a desktop build the same interface is Node's own
`fs` and `net`.

## 3. Span annotations

Placing something on code that survives edits and reformatting (SPAN-ANNOTATIONS.md): `editor.annotations.refer`,
`resolve` and `spans`, commands worker-pod registers. Notes, insights, the event sheet and the debugger already use
them, and `SpanRef` comes from util/silo's `annotations`.

**To do:** nothing to move — publish it: its types in the package, and its contract documented there (batched refer and
resolve, what a lost reference looks like).

## 4. Pane views (the Margin pane's tabs)

The pane beside every editor (components/monaco-vscode-api/pane.ts) has a strip of tabs on its first line. VS Code has no
API for anything like it, and today one consumer owns the strip: live-values.ts lists Margin and two disabled
placeholders, Cards and Event sheet — though the event sheet is an extension of its own.

**The extension point:** a manifest key, `contributes.paneViews` (VS Code doesn't act on keys it doesn't know; core reads them
from `vscode.extensions.all`):

```json
"paneViews": [{ "id": "event-sheet", "label": "Event sheet", "title": "The program's conditions and actions" }]
```

and a provider, the command `<id>.paneView` (the view's id), asked for a file's view whenever its file or the view
changes: entries on spans of lines (a span reference or line range), each rendered from data — markdown, or rows of
cells — with actions that run commands; groups (cards drawn around lines); gutter marks. Core draws them as it draws the
margin today. Data, not DOM: a pane view's rows sit level with the code's lines and move with it (view zones, wrapping),
which a webview can't follow, and the pane stays one look.

**Dogfood:** the Margin tab becomes the first provider — live values, notes, the crash and the capability question as
its entries — and the event sheet extension contributes the tab its placeholder holds: the game's conditions and actions
beside the code they're in (its map and builder stay the webview view they are). The cards projection (PROJECTIONS.md)
is a third.

## 5. Margin entries

Within the Margin tab, the same entry shape from several providers: live values, notes, coverage's marks, a run's end, a
capability question — each owned by one extension today but drawn by live-values.ts. A provider contributing *into*
`margin` (rather than a tab of its own) gives editor-contrib's interpreter a way to add its own cards.

**Dogfood:** notes and insights move their margin entries onto it. Comes after 4, which fixes the entry shape. Entries
as data are also what a native rendering draws (6).

## 6. VS Code's own contribution points

Where VS Code has a contract for what we built ourselves, we move onto it — the run contract's lesson, applied to the UI
the extensions add. monaco-vscode-api implements each API below; the comments and testing services are on in our
workbench, the chat service isn't.

| Ours | VS Code's | Decision |
| --- | --- | --- |
| The Rules view (core UI) | A tree view (`contributes.views`, a TreeDataProvider, inline actions) | **Moved** (2026-10-10): the capabilities extension's tree (rules-tree.ts) beside Capability calls — Yours / Shared, a rule's sentence and its line, Remove and Re-place at selection inline, New Rule in its title — from the editor's commands (`silo.rules.list`, `.open`, `.new`, `.remove`, `.replace`). The rule editor stays ours, in the Rule view under it — nothing native edits predicates |
| Live values at a stop | `InlineValuesProvider`, the debugger's own contract for values beside the code | **Add**, beside the margin: values of one session, mapped from the text that ran, so durability doesn't come into it |
| Margin entries — the question, a run's end, coverage counts | CodeLens, inlay hints, decorations | **Later, with 4 and 5:** entries as data, drawn richly by the pane and natively by these — the margin's desktop face |
| Agent tools (page-tools.ts, every tool in one place) | `contributes.languageModelTools`, `vscode.lm.registerTool` | **Not adopted:** those are tools for an agent inside VS Code — its chat — and VS Code isn't an MCP server that hands them to one outside. Our agent is outside: debug-mcp reaches the tab over the hub. A contributed tool would connect nothing we have |
| Notes | The Comments API | **Not adopted.** A thread is a file and a range the controller owns; VS Code keeps nothing and follows nothing past typing — no reformat, branch or move to another file. Our span anchors would survive only as the truth behind it, our resolver setting each thread's range: two trackers moving one thread (VS Code's as you type, ours after), a thread rebuilt whenever its code moves files, and the display losing the span's precision. And the contract buys no interop — a controller's threads are its own, no extension can read another's. Revisit only as a second view on a desktop build |
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
- **Core's UI** — the margin, the Rules view → 6's native renderings; the margin's pane itself has no counterpart.
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
3. ~~The Rules view as a tree view~~ — done (2026-10-10); inline values (6).
4. Workspace tools for an agent (below), so one develops in the workspace as on a local machine.
5. Pane views, with Margin and the event sheet as its first two providers; margin entries and their native rendering.
6. The decider — when a second decider needs it.

## Workspace tools

debug-mcp's tools watch and debug — the editor, problems, runs, previews, the debugger, the margin — but an agent can't
yet do the work itself, as it would on a local machine: read and write files (what's open, unsaved, included), edit one
by an exact string, find files and search their text, run a command and read its output, and use git. Each a page tool
of core's (the workspace and the shell are core's), served over the hub like the others: read through VS Code's
documents then zen-fs; write and edit as a `WorkspaceEdit` (so an open editor, undo, the edit history and format on save
see it, as typing); find with `findFiles`; run in core's just-bash, as the terminal does (`node` and `npm` as there); git
through the git service.
