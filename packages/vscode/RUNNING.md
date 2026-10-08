# Running: one way, in the debugger

How a program is started, whatever started it. Written 2026-10-07, from a survey of every way the UI can start one and
the four different things they did. Supersedes the two-mode plan (tsval for debugging, an almostnode "production" mode
for real runs, LIVE-VALUES.md and the capability-enforcement plan): there is one mode, and it is the debugger.

## The problem

Fourteen entry points, four runtimes, each entry point choosing by a rule of its own:

| Started by | Ran in | What you got |
|---|---|---|
| Shell ▷ → "The file in the editor", editor ▷ *Run and Debug File*, F5, the margin's *Run*, an agent's `debug_start` | the debug worker (tsval) | the Debug Console; live values, cards, coverage; capability stops in the margin; every effect an inert stand-in |
| Terminal `node f` (and a task, `npm run x`) when the source looks like a one-shot script | the debug worker | the same — but the terminal says only "running in the Debug Console"; the command line's args, cwd and env, and the terminal's stdin, dropped |
| Terminal `node f` when the source matches `.listen(`, `setInterval(`, `process.stdin.on`, … (a regex: `lifecycle.ts`) | the script worker (almostnode) and an empty "production" session | the terminal; real effects, each allowed by a popup; no values |
| `npm run dev` / `vite`, a Service in the ▷ menu | the dev server's preview | a preview window; no values |
| A file that mentions `ReactDOM` | the debug worker's React mode | a "tsval Preview" window: no module loader, no values, no policy |

And: the left rail's *Run* does nothing; *production* is offered in VS Code's debugger picker and starts a session that
never ends; the shell's entry points swallow their errors. One program, run from two places — or edited to add a
`setInterval` — ran in different worlds: inert effects and values, or real effects and none.

The cause is that running and debugging were two things: a debug run zero-authority (stand-ins, so values but no
effects), a real run with effects but no values, and every entry point picking one.

## The model

**Everything runs in the debugger.** There's one action — *Run* — and every way in (the shell's ▷, the editor's ▷, the
left rail, the terminal's `node`, a task, the margin, an agent) starts the same session: tsval evaluating the program's
own files on almostnode (MODULES.md), its event loop deterministic. Live values, cards, coverage and the run log are
always there; a breakpoint stops it if there is one. There's no *Run* versus *Debug*, no *Run Without Debugging* that
runs something else.

**What runs it is invisible.** The user runs their program; they never choose a runtime, and nothing they see — not a
menu, not an output pane, not a run's label — names tsval, almostnode or a worker. A program that can't run this way
(below) runs another way behind the same controls.

**Effects are real, decided per call.** A capability call the policy allows happens for real — through almostnode's own
shims (fs on the shared workspace, `child_process`, a server's port) and the network — and a run that writes a file
writes it. A call the policy hasn't decided stops at its line and asks in the margin (RULES.md: Allow once, this run,
always, Deny, Rule…) — the one way a run asks, no popups. A denied call fails as Node's would; a mocked one gets what
its rule gives. The stand-ins stay what they are now only for a denied or mocked call and for a probe's fork.

**Deterministic.** tsval's event loop has a virtual clock, a seeded random and an ordering it can replay (the
explorer's schedules). A real effect's result enters the run as an event, and is recorded at its seam (RULES.md,
slice 2: what a call returned) — so a run can be run again exactly: its clock, its seed, its schedule, and what each
call returned.

**Output goes where it was started.** A run started from the terminal prints there and reads its stdin there, with the
args, cwd and env the command line gave; the Debug Console mirrors it. A run started from a button prints in the Debug
Console, which is its stdin. The margin's mocked `process.argv` is the args only when none were given.

**A service is one too.** A run that listens is a service (runs.ts), alive while it's held (a server, a stdin reader);
its port answers the preview (`virtual.debug.<port>`), and a page it serves gets the preview's taps (workspace-runtime.ts)
— so opening its port opens a preview window, as `npm run dev` does.

**Apps.** A web app's own code runs in a browser page — the preview's — not in a worker: its DOM, its layout, its
events are the browser's. Its dev server is a program like any other, and runs as one; the page is observed (taps,
evidence, instrumentation: RUNTIME-EVIDENCE.md), and its fetches decided at the service worker (the same decision, the
same margin). React mode — tsval rendering a component into a window of its own — gives way to the real preview. A
page's code isn't stepped, and its breakpoints are recorded stops, not live ones (below).

## Apps: recorded stops, not live ones

What a debugger does — stop at a line, then step from it — needs whoever runs the code to be able to stop. tsval can, for
everything it runs: a Node program's code, its servers' handlers, its timers' callbacks (and, in a callback a library
makes synchronously, by blocking its worker until the user goes on). A page's code is another matter, and decided by the
page, not the framework:

- **Page code can't pause page code.** Only the browser's own debugger stops a page, and a page can't drive it — the
  preview's DevTools speak the protocol through chobitsu, a JavaScript implementation that can inspect a page but not
  stop it.
- **The page's main thread can't wait.** A worker can block until it's told to go on (that's how tsval pauses inside a
  library's callback); the main thread can't, and the page's code runs there.
- **The browser calls page code synchronously.** An event listener, a custom element's lifecycle, an observer's
  callback, a getter the browser reads — each is called from the browser's own stack. Run every script in the page on
  tsval and a breakpoint inside a click handler still can't stop, because nothing can wait there. Every framework is
  built on event handlers, so no framework escapes it.

So the ways to stop live inside a page's handler are the browser's debugger, which the editor can't drive, or the app
moved into a worker with its DOM proxied from the main thread (Partytown's way): native React, real pauses, but every
synchronous DOM read a round trip, and what must be decided in the event — `preventDefault()`, a controlled input's
value, focus — decided too late. That's slower than the real page and different from it exactly where people debug
(forms, inputs, focus, events), and each framework touches the DOM its own way: more proxy, more gaps.

**A breakpoint in a page is a recorded stop.** Each time its line runs, what's in scope — locals, arguments, `this`, the
call stack, and which turn of the app it was (which event, which render) — is recorded and shown in the margin, as live
values are: a column per time it ran. The dev server already instruments what it serves (RUNTIME-EVIDENCE.md), so the
recording is its instrumentation, mapped back through the source maps the framework's compiler gives (JSX, Vue's single
file components, Svelte, Solid all reach the page as compiled JavaScript with a map) — framework-neutral, at the page's
own speed, in the real page. What it doesn't do is let the user step from there: a page's code is observed, and a Node
program's is stepped.

Determinism goes with it: a page isn't replayed. Making it so — its clock, randomness, timers, frames and channels on one
virtual loop, its inputs and fetches recorded — would buy replaying a page's bug exactly and stepping back through UI
code, but stepping back needs stopping first, and the page can't stop. Not built, and not planned.

(The browser's DevTools remain for a preview popped out into its own window — the user's, outside the editor.)

## What can't run this way

The hope is none; the plan is as few as possible, each a named case with a reason, kept on a list here and shrunk.
There's no fallback: a program that meets something tsval can't run **fails loudly** — the run ends there, saying what
it met (*Can't run this yet — the debugger doesn't support …*), marked on that line as a crash is, never dressed as the
program's own error and never naming a runtime. A second, native world would be a second set of behaviours to keep
honest, and it would hide each gap instead of making it a bug to fix.

Known and suspected:

1. **A browser page's own code** — a previewed app. It runs in the browser, which is the point; observed, its
   breakpoints recorded stops, not stepped (*Apps: recorded stops, not live ones*).
2. **Too slow to interpret** — measured (step 0): not a build, a bundler or a server (their work is in packages, or
   light per request), but a program whose own code computes heavily — a simulation, a game's update loop. The answer
   is making tsval faster, not keeping a second world.
3. **Packages** are native already (MODULES.md: a package is never stepped) — inside the run, on almostnode, not a
   separate mode. Their own async work is on the host's loop, outside the deterministic one.
4. **What tsval doesn't support yet** — a syntax or a builtin it lacks. Each is a bug to fix, not a mode; the run fails
   loudly where it met it (above). (Step 0 found a debug run's globals were ECMAScript's alone; a run has the globals a
   Node program has now — the web ones and `Buffer`, workspace-runtime.ts `programGlobals`.)

## Another interpreter

What Run starts is a debug type: `run.debugger`, tsval by default. Another extension's debugger can be it — an
interpreter built from editor-contrib's starting point (`contrib/`, kept in brianjenkins94/editor-contrib), loaded by
URL (contributed-extensions.ts): listed by the site's own `extensions.json` (editor-contrib's site is this editor's
tarball, `editor.tgz` on its site, with the extension added), or a page's `?extension=` while it's developed. Its
manifest's `configurationDefaults` makes it `run.debugger`. The editor's ▷ and live runs then start that; its sessions are runs like
tsval's (worker-pod's contributed-debuggers.ts asks core for each one's id), and the custom events it sends — `values`,
`coverage` — are the margin's and the evidence's, as tsval's are. Stepping, breakpoints and the Variables view are the
Debug Adapter Protocol's. What stays tsval's: a terminal's `node` (it's Node's semantics), capability stops, replay and
orderings. test/contrib.mjs runs contrib/ in a real editor, so a change here that breaks it fails there.

## Entry points, after

| Started by | Does |
|---|---|
| Shell ▷, left-rail *Run*, editor ▷, F5 (and its menu twin), the margin's *Run* | Run the file in the editor (a program file; anything else isn't offered) |
| Terminal `node f [args]` | Run `f` with those args, cwd and env, in that terminal |
| `npm run x`, a task, a Service in the ▷ menu | The script, through the terminal, so each `node` in it is a run as above; `vite` starts the dev server as a run |
| An agent's `debug_start` | Run, returning at the first stop |
| *Explore Orderings* | Run every ordering (as now), then Run the one picked |

## What goes

The source regex (`lifecycle.ts`'s service/task guess deciding the runtime — it may stay as a label); the script worker
(gone, 2026-10-07: the dev-server worker stays); the *production* debugger in VS Code's picker and launch.json;
the production adapter (a run is a tsval session); React mode; the left rail's placeholder; the swallowed errors (a run
that can't start says why). And the two run ledgers become one: every run in `runs.jsonl`, with its evidence.

## Steps

0. **Measure** (done; `bench/running.ts`, Node 24, median of 5). The same program natively on almostnode, on tsval, and
   on tsval as the debug worker runs it (coverage, profile, observed sites, the value trace):

   | Workload | native | tsval | the debugger's |
   |---|---|---|---|
   | The program's own tight loops (primes < 20k) | 0.5ms | 1.1s (×2200) | 1.5s (×3000) |
   | 20k records through map, filter, sort, JSON | 5ms | 250ms (×49) | 363ms (×72) |
   | A server: 500 requests, a small JSON handler | 0.9ms | 38ms (×41) | 55ms (×60) |
   | Build-like: the work in a package | 0.7ms | 0.9ms (×1.2) | 0.7ms (×0.9) |

   Ordinary program code runs 40–70× slower than native, and tight numeric loops — what V8 compiles to machine code —
   thousands of times slower. The debugger's instrumentation adds about 40%. But a package's work is native under tsval
   (MODULES.md), so a build, a bundler or a type-check — whose work is in packages — costs nothing more; and a request
   is a tenth of a millisecond, so a server answers at an interactive pace. Case 2 is narrower than feared: a program
   whose own code computes heavily (a simulation, a game's update loop, an algorithm on big data). Speed isn't the aim;
   this is where the fallback would be felt first, and where making tsval faster pays.
1. **One Run** (done). Every entry point onto one path — `runs.begin`, then a tsval session — with errors shown. The shell's
   and editor's buttons and the left rail run the file in the editor, program files only; the production picker entry
   goes. (The terminal still routes, until step 3.) Done: the shell's ▷ item, the left rail's *Run* and the editor's ▷
   (now *Run*, alone in its menu: *Explore Orderings* moved to the editor's "…", so it can't become the button) all call
   one `runProgram` (debug-control.ts) — a JavaScript or TypeScript file only, a run that can't start saying why in a
   notification; a session is named by its file; the production debugger hidden from the picker (`hiddenWhen`); a task
   already running shows its terminal rather than nothing; and a run's globals are Node's (workspace-runtime.ts'
   `programGlobals`: `URL`, `TextEncoder`, `Buffer`, … — not `performance` or `crypto`, which vary run to run). The
   debugger's type is still `tsval` in a launch.json someone writes by hand; its label is *Run*.
2. **Real effects** (done, but for the script worker's popups — step 3's). An allowed call made for real through
   almostnode's shims, its result recorded; asking in the margin the only way; the script worker's popup path retired
   for runs. Done: a program's `fs`, `child_process` and `fetch` are almostnode's own (and the network), each gated call
   decided as it's made (debug-worker.ts `gated`) — a call the policy allows (an fs read, by default) or the user allowed
   at its stop (Allow once, this run, always, a rule) happens for real, a write let through the runtime's refusal while
   it's made; one denied, or that nobody allowed (a call the static check can't see, so never asked about), fails with
   EACCES as Node's would, where it used to return an inert result; a mocked one gets its rule's value. What an allowed
   read returned is recorded through the adapter (no call of the worker's own: a reply to `debug-worker` reaches every
   one). A run of an ordering exploring found replays it — its calls the stand-ins they were. Not yet: a package's own
   network is the worker's, unasked (its fs writes are refused) — a package's calls decided too is open.
3. **The terminal** (done). `node f` always a run: output and stdin in its terminal, its args, cwd and env; the regex no
   longer decides anything. Done: `node f [args]` (terminal-node.ts) is always a debug run — the source's look at what it
   does is only the running list's first label, and a run that listens becomes a service with its port; the command
   line's arguments are its `process.argv` (none given: the margin's Mock, as before), the shell's directory its
   `process.cwd()` (a relative path in its fs calls that directory's) and its exports its `process.env`; its output is
   printed in the terminal (the Debug Console mirrors it, but for the script's completion value), and a line typed there
   is its stdin, Ctrl-D the input's end. Focus stays in the terminal: a terminal's run opens neither the Run and Debug
   view nor the Debug Console. (The script worker that once ran a program the debugger couldn't take is gone: step 7.) The tour's diagram is now drawn from everything it saw all
   session (a look every second), not its last look: each debug run's worker reports as `debug-worker`, and the last
   one's report replaced the others'.
4. **Services and apps** (done). A run that listens opens its preview; `vite` and the dev server as runs; React
   mode retired. Done: a run's own server, listening, opens its preview window on its port (`preview.open` with `server`:
   no dev server started for it) and closes it when the run ends — a debug run's or a fallback's alike (node-runner.ts);
   and Run on an app's file — the page loads it, or it's a component (`.jsx`, `.tsx`), or it uses `react-dom` or
   `document`, with an `index.html` up from it in its own package — runs the app: its `dev` script as a task (the dev
   server a run, its preview open), or, already running, its preview shown again (launch.ts `appRootOf`/`runApp`; F5's
   resolver too). React mode is removed: its reconciler, its render window and its protocol (a live pause in a component,
   but on a fake DOM, for React alone). The page's virtual loop isn't built (*Apps: recorded stops, not live ones*).
5. **Recorded stops in the page** (done). A breakpoint in an app's code records what's in scope each time its line runs, by
   the dev server's instrumentation, mapped through source maps, and shows it in the margin — a column per time it ran.
   Done: the editor's breakpoints go to every dev server (`preview.stops`, recorded-stops.ts; on a change, its files
   re-instrumented and hot-updated); before the first statement on a breakpoint's line the instrumenter puts
   `__ev.p(range, () => ({ …in scope }), () => this, where)` (almostnode instrument.ts — what's in scope read off the
   syntax: the parameters around it, its imports, what's declared before it), whatever the evidence level; the page
   previews each value as the stop is hit (a DOM node or an event by what it is: `<button#add>`, `PointerEvent click`)
   with the event it was handling (`during`), keeps each stop's latest twenty hits and reports them soon after
   (`stops.preview`); and they reach the margin as a session of values for the file, anchored in the text of the version
   that ran. Its range is written into the call, not the module's site table: the page keeps a version's table, and a
   breakpoint changes no source.
6. **Stepping a recorded handler** (done). The page can't stop, but a recorded call can be stepped afterwards: at a recorded
   stop the page also records what the function was called with, what it closes over and what each call it makes
   returns, and tsval runs the same function from there, fed those results — line by line, back and forth, in VS Code's
   debugger, while the live page has gone on. Replay, at a function's grain rather than the page's: what made the page
   virtual loop costly, without it. Done: the function a stop is in (a function or an arrow whose arguments can be had —
   not yet a method) is instrumented to record each call of it — on entry its free names, `this` and arguments, each
   call's result where it was made, all as snapshots (worker-pod snapshot.ts: data as data, a function or a DOM method as
   a named stand-in), kept with the latest five hits; *Debug: Step a Recorded Stop* (replay.ts) picks one and starts a
   session on it (debug-worker.ts `launchReplay`, replay-run.ts): the recorded version's text, everything but the
   function blanked so every line is the file's, its free names bound around it, each call to what it couldn't record
   handed its result by where it was made, a call given one of the program's own functions (`items.map(fn)`) made for
   real so it can be stepped into. A handler passed to a call is named by it (`addEventListener("click")`). Not yet: a
   call into another of the program's functions is handed its result rather than stepped into.
7. **Fail loudly, not fall back** (done). Something tsval can't run ends the run where it was met: tsval notes the
   site of its own gap as it notes a throw's (`throwSite`), and the debug worker says *Can't run this yet — the
   debugger doesn't support …* in the run's output and marks the line, as a crash. No native fallback (*What can't run
   this way*): the terminal's `node` says the debugger couldn't take it and exits 1, and the script worker — the plain
   runtime's runner — is removed, with its synchronous capability route in the service worker.

## Open

- A fast path for case 2: making tsval faster (done once: ~2.8×, 2026-10-07) or a compiled tier (tsval COMPILE.md,
  parked until a program is actually too slow to debug).
- Replay: a run's recorded results let it run again exactly — whether *Run again* is that, or a fresh run.
- Effects on step-back: travelling back past a real write doesn't undo it. Show where a run's real effects are, so
  stepping back past one is visible.
- What a recorded stop keeps of an object (a preview, a depth, how many of a line's stops), and how one stop is told
  from another (the event, the render, the turn).
