# Discovered architecture

The live architecture view, and the diagram in ARCHITECTURE.md, should show the editor as it is — every part that does
something, what it talks to, what it keeps — and they should stay that way without anyone maintaining them. Everything
on them is discovered from the running editor; the only things declared are the rules it's held to.

## Why

- **Today's work doesn't show.** The view's smallest unit is a realm and its edges are hub links between realms. A day
  of work that added span annotations, runtime evidence from tsval and from previews, notes and the evidence hover
  changed nothing on it: it all lives inside realms that were already there (the workbench, the extension host, the
  node worker, a preview window) and rides links that were already there.
- **Declarations drift.** `architecture-model.ts` declares 96 subject families by hand, and ARCHITECTURE.md's prose
  named a component that no longer existed and a channel a worker no longer used. Anything kept by hand falls behind.

## What's observed already

- **Contexts and links.** Every hub announces itself and its links on `$sys.arch` (observability's arch reporter), so
  the view knows each realm, worker and preview window and what links them.
- **Messages.** Every message's subject, direction, size and kind (call, reply, event) is counted per link.
- **Channels off the hub.** Probes report network requests, worker creation, window messages and `MessagePort`s.
- **The workspace filesystem.** Each realm wraps its `/workspace` mount and reports every operation, and the workbench
  labels its operations by caller (`vscode ·`, `direct ·`, `seed ·`, `restore ·`, `persist ·`).

So the traffic of today's work is already in the view's data: `evidence.preview` from `preview:*` through the shell to
the workbench, `annotations.resolve` from the pod, `preview.version` from the workbench to the node worker. It isn't
drawn as anything.

## What can be discovered, without reading source

### Extensions, by their own API

Each extension gets its own instance of the `vscode` API. Wrapping `commands.registerCommand` and
`commands.executeCommand` on each instance attributes every command to the extension that registered it and the one
that called it. Their names and descriptions come from each extension's manifest. That finds:

- notes → `editor.annotations.resolve` → worker-pod;
- insights → `typescript.tsserverRequest("_types.at")` → the TypeScript extension → the capabilities plugin;
- every extension's place on the editor's command surface.

### Stores, by what's written

- **Files.** The zen-fs probe reports each write's path. Paths that share a shape collapse into one store, their
  varying segments (users, environments, files) becoming placeholders: `.silo/evidence/<user>/<env>/<file>.jsonl`,
  `.silo/notes/<user>/<file>.jsonl`, `.silo/local/samples/<file>.jsonl`, `.silo/runs/<user>.jsonl`. Each store gets
  the realms and extensions that wrote and read it.
- **Databases.** The IndexedDB probe already names every database each realm reads or writes (`bablr`, `silo-local`,
  `workspace-fs`), and who owns it.

### Flows, by causality

- **Traces through the hub.** Debug actions already carry a trace across hops. If the hub carried the current trace on
  every call it makes and every message it sends while handling one, chains would reconstruct themselves: a note's
  resolve is `editor.annotations.resolve` → `annotations.resolve` → `bablr.resolve` → its reply; a preview page's
  report is `evidence.preview` → `preview.version`; a run ending is the evidence writes to `.silo/`.
- **The limit is async work.** The browser has no async context, so a trace carries through a handler's synchronous
  part, and through an RPC handler's own awaited calls when the hub hands it the context, but not through arbitrary
  timers and callbacks. Where the trace is lost, a message a context sends consistently soon after it receives another
  is linked to it as inferred, and drawn as such.

### Components within a realm

The workbench's hub serves `bablr.ts`, `evidence.ts`, the git service and more, so contexts alone don't separate them.
Two signals do, with no source read:

- **Subject namespaces.** What a context serves and subscribes to, grouped by namespace (`annotations.*`, `spans.*`,
  `evidence.*`, `git.*`).
- **Where a handler was registered.** The hub records a stack trace once, when a handler is registered, and keeps the
  nearest function name outside the hub (`startBablr`, `installEvidence`, `installGitService`). Registration happens
  at start-up, so it costs nothing per message. It names components in the development build; a minified build falls
  back to namespaces alone.

### Features, by clustering

Subjects that share a namespace, or that keep turning up in the same flows, form features. "Runtime evidence" emerges
as one connected cluster: tsval's `observe` and the debug worker, the dev server and the page runtime, `evidence.ts`,
the BABLR worker, the `.silo/` stores, and the hover and hints. Nobody tags it.

## What can't be discovered

- **What never ran.** Discovery shows what the session or the tour exercised; an unexercised path is invisible.
- **Intent.** Which way a subject may travel and what may cross a preview's link are rules, not observations.
- **The inside of a component.** The annotation strategies, the evidence folds, the typed re-scoring show as a call and
  how long it took.
- **The file.** "The workbench serves `annotations.*`, registered by `startBablr`", not `bablr.ts:151`.

## The model becomes the rules

What stays declared in `architecture-model.ts` is what can't be observed:

- **Policy.** Which realms may send a subject which way, and what a preview window's link allows
  (`previewAppPermissions`). Conformance holds discovered traffic to it, as it does now.
- **Realms' entry points and containment.** Which context is which realm, and which box holds which.

The 96 family descriptions go, and so does the stores table: what each family is and what each store holds comes from
what was discovered. A rule can still carry a sentence of intent where the name alone doesn't say it.

## The live view

- **Three layers.** Realms hold components (extensions, and in-realm components by namespace and registering
  function); components connect by the subjects and commands between them; stores sit beside the realms, with write and
  read edges from the components that touched them.
- **A feature lens.** Pick a feature and the rest fades: runtime evidence lights up from the instrumenter and tsval's
  `observe` through to `.silo/` and the hover.
- **Flows.** Pick a message and see the chain it belongs to, as a sequence: what caused it and what it caused, inferred
  links dashed.
- **Two lists that show gaps.** Traffic that breaks a rule (as now), and rules or components no traffic has touched
  this session.

## ARCHITECTURE.md's diagram

The diagram is rendered from the last tour's observations, not from declarations. The tour already saves its observed
snapshot (`architecture-tour.json`); it writes the diagram from it too. The architecture workflow re-runs the tour, so
the committed diagram is checked against a fresh one: a change that adds a component or a flow shows up as a diff to
the diagram in the same commit.

## A static scan, later

Reading the source would add what never ran: a `serve(hub, "…")` no test reaches, a store no run writes. It's a
complement, not a replacement — the edges it finds that no run has seen are untested paths, worth listing on their
own — and it waits until discovery has shown how far it gets alone.

## Building it

1. **Extensions and commands**: the per-extension API wrap; command edges on `$sys.arch`. Done: the build hands every
   bundled extension a `vscode` whose `commands` are counted (extensions/command-tap.ts, build.ts's commandTap); each
   extension host sends its totals to worker-pod (`editor.arch.commands`), which puts `ext:<name>` nodes and `cmd …`
   edges on the view; commands nobody bundled registered belong to `ext:vscode`. The tour finds notes and insights →
   `editor.annotations.*` → worker-pod, insights → `editor.metrics.read`, and notes, insights and eslint → the
   TypeScript plugin's `_types.at` and `_eslint.fixAll`. Only our bundled extensions are tapped; one installed from the
   gallery isn't (yet).
2. **Stores**: path shapes from the zen-fs probe's writes; an `indexedDB.open` probe in each realm. Done: the zen-fs
   probe records each read, write, create, unlink and rename of a file in a tool's dot-directory on a `store:<shape>`
   node (architecture-zenfs.ts, storeShape — a directory's listing or a stat isn't a store's content), silo's local/
   included (a mount of its own store); the command tap counts each extension's `workspace.fs` reads, writes and
   deletes the same way; databases need no new probe — the IndexedDB probe already names each one it touches.
   `discoveredStores` reads them back, with their writers and readers. The tour finds the silo stores (evidence, notes,
   runs, samples, the capability policy and ledger), BABLR's cache and VS Code's own databases — and that the notes
   extension reads `.git/config` (for who you are).
3. **Flows**: the hub carries the trace through handlers and RPC handlers; inferred links where it's lost. Done: every
   hub message has an `id`, and a message sent while a hub runs another's handlers names it as its `cause` (hub's
   Envelope); an RPC call takes its cause when it's made (a wait for a responder is an await), `serve`'s reply names
   its call, and a call a queue defers names what it was queued for (`handlingMessage`, RpcRequestOptions' `cause` —
   core's BABLR queue does). The reporter samples both; observability's `flowsOf` follows them into flows, a message
   with no cause linked, inferred, to the last one its sender received within 50 ms. The tour finds a note's resolve
   as the pod's `annotations.resolve()` causing core's `bablr.resolve()`, named. A local caveat: a `file:`
   dependency's change doesn't reach Vite's dependency cache (`node_modules/.vite`) until it's cleared.
4. **Components**: the hub records where each handler was registered; namespaces group what a context serves. Done:
   the hub takes a stack trace once, as a handler subscribes, and keeps the first named function outside the hub (an
   engine's or a library's internals — `_deliver` — passed over; a minifier's names, three characters or fewer, count as
   none); `inspect()` reports them as `sites`, which the reporter already sends. `componentsOf` groups a hub's
   subscriptions by registrant, or by namespace where none survived, a session's or a port's own subject folded to
   `*`. The tour tells the workbench's `startBablr` (`annotations.*`) from its `installEvidence` (`evidence.*`), its git
   service, its run registry and the rest; CI's minified build falls back to namespaces, and the test holds either way.
5. **The live view**: components in realms, stores, the feature lens, flows, the two gap lists.
6. **The diagram from the tour**, and the model trimmed to its rules.

## Decisions

Decided 2026-10-04: every one as recommended (the **bold** option).

- **A1 · Naming components within a realm.** **(a) subject namespaces, refined by the function that registered each
  handler**; (b) a named child hub per component (`hub.child("bablr")`) — exact, but one line in each component's code;
  (c) namespaces only.
- **A2 · Flows.** **(a) the hub carries traces where it can, and links the rest by timing, marked as inferred**; (b)
  traces only, gaps left as gaps; (c) timing only.
- **A3 · Stores.** **(a) discovered: path shapes from writes, databases from `indexedDB.open`**; (b) declared, as today.
- **A4 · ARCHITECTURE.md's diagram.** **(a) rendered from the tour's observations, checked by the architecture
  workflow**; (b) rendered from declarations, as today.
- **A5 · Features.** **(a) namespaces, merged by co-occurrence in flows**; (b) namespaces only.
- **A6 · The declared model.** **(a) only the rules (policy, entry points, containment); descriptions discovered**; (b)
  keep the families and their descriptions beside discovery.
- **A7 · A static scan.** **(a) later, as the "never ran" complement**; (b) now, alongside discovery.
