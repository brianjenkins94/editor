# Modules: almostnode resolves, tsval evaluates

How a program's modules are found and run — the same way whether it's run or debugged. Written 2026-10-07, correcting
the layering the first cut of services under the debugger took (5919258).

## The misstep

A debug run made tsval the host and almostnode a library it called into: the debug worker gave the entry file its own
`require`, `module` and `exports`, and tsval's `resolveModule` decided per specifier — a capability stand-in, almostnode's
`Runtime.require`, or an inert placeholder. So there were two module systems. A script run on the script worker
resolves through almostnode's loader; the same script under the debugger resolved through tsval's shim on top of it, and
the two can disagree — on a package's `exports`, on extension and index resolution, on cycles, on the module cache — and
the entry file never entered almostnode's cache at all. And the program's other files ran natively, unstepped, because
nothing but the entry was tsval's.

What was right stays: dependencies run natively on almostnode; servers and stdin go through its shims.

## The model

**almostnode is the runtime.** It owns module resolution, the module graph and the module cache — for a run and a debug
run alike. **tsval is an evaluator** almostnode hands the program's own files to. What decides running versus debugging
is only which evaluator takes the program's files: almostnode's native one, or tsval's stepped one. Packages and built-ins
are always native.

The program's files are the workspace's own code: files under the workspace, outside `node_modules`. A package is never
stepped (as a debugger without source maps doesn't step a library); a program file always is, entry or not.

## almostnode's part

Loading is split into what it already does in one function (`createRequire`'s `loadModule`):

- **resolve** `(specifier, from) → { kind: "builtin" | "package" | "program", filename }` — Node's algorithm as it is
  now (`exports`, extensions, `index`, `node_modules` walking), unchanged, just callable on its own.
- **transform** — ESM to CJS, as now, for what's evaluated natively. (tsval interprets a program file's own source,
  TypeScript included, so it never needs this.)
- **evaluate** — natively, as now; or, for a `program` file, by the runtime's **evaluator hook** when one is set.

And the module cache gains a way in: **register** `(filename, module)` — a module evaluated elsewhere (by tsval) is one
instance for everyone, so a package that requires a program file (a framework reading the user's config) gets the same
`exports` the program has.

The hook is what a native caller reaches: a package requiring a program file calls it synchronously, and tsval evaluates
the file in a nested run — not on the main stack, so stepped only through a breakpoint in it (as any host-invoked handler is). The
common case — the program requiring its own files — doesn't go through the hook (below).

**Built-ins by who asks.** `require("fs")` resolves by the requiring file: from a program file in a debug run, the
capability stand-in (inert, gated — what a capability stop is about); from a package, the real shim with writes refused
(as `hostModulesFor` does now). The stand-ins become almostnode built-in overrides for program files, declared where
built-ins are, not a tsval resolver.

## tsval's part: more than one file

Today a machine has one `sourceFile`, and positions mean offsets in it. It becomes a machine over several:

- **A frame knows its file.** A module's frames (and every function created in it) carry their source file; `location()`
  answers `{ file, line, character }`. Breakpoints are by file and position. `coverage`, `profile`, `trace` and `observe`
  report per file; `throwSite` names its file.
- **A module frame** evaluates a file: its scope holds `module`, `exports`, `require`, `__filename`, `__dirname`; when it
  completes, its `module.exports` is the module's value.
- **`require` is an intrinsic** (as the event loop's timers are): it asks the loader to resolve. A `program` file not in
  the cache is registered (its `exports` object, before it runs — cycles see the partial one, as Node's do) and its
  module frame pushed **on the main stack** — so stepping goes into it, breakpoints in it stop, and a fork carries it.
  Anything else is loaded natively by almostnode and its exports returned.
- **ESM.** An importing module's program-file imports are evaluated before its body, depth-first, each once — the link
  order — then its imports are bound. A package import is native, as above.
- **The loader is an interface** (`VMOptions.modules`: `resolve`, `loadNative`, `register`) — tsval knows nothing of
  almostnode. A host with no loader keeps today's behaviour.

## The debug worker's part

It starts the entry through almostnode with tsval as the evaluator, and deletes its shim: no `require`, `module` or
`exports` of its own, no `resolveModule`, no `dependenciesOf`/`hostModulesFor` scan (almostnode is always there — the cost
moves to every debug run, so its load is measured and kept off cold start). What the margin, coverage, the run log, live
values and DAP show becomes per file: a stack frame names its source, and each file's margin shows its own values,
coverage and cards. The script worker and the debug worker set the runtime up from one function — the same built-ins,
the same filesystem, the same hooks — and differ only in the evaluator and the stand-ins. (The script worker is gone
since: every run is a debug run, RUNNING.md.)

## What stays

`Runtime.require`; the keep-alive hook (a listening server holds the run open); `virtual.debug.<port>` routing; stdin from
the Debug Console; the deterministic event loop, the explorer and the profile.

**The event loop's boundary.** tsval's deterministic loop covers stepped code — the program's files. A package's own
async work (its internal timers, its promises) runs on the host's loop, as now: what a package does between the program's
calls into it isn't the program's to order. A package's callback into a program function runs as a nested job, as now.

## Steps

1. **almostnode's loader split** (done, 0e8c9d8). `resolve`, `loadNative`, `register` and the evaluator hook on `Runtime`; built-ins by
   requester. Tests in almostnode: resolution unchanged (its own tests), a registered module seen by a package, the hook
   called for a program file a package requires.
2. **tsval over several files** (done: tsval's modules.ts — the loader interface, module frames, the entry a module
   too, ES module exports as getters on `module.exports`, breakpoints and locations by file). Frames and positions by file; module frames; the `require` intrinsic and ESM link order
   through `VMOptions.modules`. Tests: stepping from one file into another and back; a breakpoint in an imported file; a
   cycle's partial exports; import order; a fork mid-import; coverage and profile per file.
3. **The debug worker on almostnode.** The entry through the runtime with tsval as evaluator; the shim deleted; stand-ins
   as built-in overrides; per-file stack frames, coverage, values, cards and run log. Tour: step into an imported file,
   stop at a breakpoint in it, see its values in its own margin; the server and stdin tests unchanged.
   - *Done (3a):* the runtime and evaluator, the shim gone; breakpoints in any file (the launch's `files`, a
     `setBreakpoints` by file); a frame names its file, function and line text; coverage and observed sites per file
     (the gutter draws each). The workspace buffer comes in the launch (the pod holds it), not by a call: every debug
     worker's hub is `debug-worker`, so a reply to one reached them all. Loading almostnode costs a launch ~30 ms.
     Capability stops and rules then came per file too (below).
   - *Done (3b):* each file's values, cards and run log in its own margin (a live record per file; its text sent with
     its first values); a run's end and a crash marked in the file they're in; evidence per file — each file that ran
     folded into its own `.silo/evidence` file and listed in the run's envelope.
4. **One runtime setup** shared by the script worker and the debug worker (done: `workspace-runtime.ts` — the runtime on
   the workspace's zen-fs with one cwd, deploy base and built-ins; a listening server found and answered one way, the
   preview's page and worker taps put in what it serves, so a debug run's pages are observed as a run's are). What stays
   each worker's is policy: a run's fs calls asked about (the service worker's decide), a debug run's packages refused
   writes and its program given stand-ins; and each one's event loop and keep-alive — node's timers for a run, tsval's
   loop for a debug run.

## Open

- An importer binds an imported name to its value when it links (the exporter has run by then, but for a cycle), not
  live as ESM's bindings are; a namespace import (`import * as ns`) reads live. Live named bindings, if a program needs
  them.
- A file's run log shows its own steps (tsval's profile counts a step to the top-level statement of the file it's in),
  so a call's line in the importer doesn't include the work done in the file it calls into.
- Capability stops and placed rules are per file: a file's gated calls are armed as it loads (the loader's register),
  its question asked in its own margin; a rule placed in it (its *program is* that file, as its margin makes it) sets
  when the program gets there, whichever file the run started from. `process.argv` is the program's, so its row and
  its Mock stay on the entry.
