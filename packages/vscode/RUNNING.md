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
same margin). React mode — tsval rendering a component into a window of its own — gives way to the real preview. An app
is the hard case for determinism (below).

## Apps and determinism

A Node program is deterministic because tsval owns everything that could vary: the clock, randomness, the order its
jobs run in, and what each effect returned (recorded). A page owns none of that. In the preview, an app runs on the
browser's event loop: `Date.now` and `performance.now`, `Math.random`, timers, `requestAnimationFrame`, a
`MessageChannel`, the order its fetches come back, and when the user clicks — all real, all different each time.

And tsval alone wouldn't fix it. Run an app's own files on tsval in the page and React itself is still a package — native,
never stepped (MODULES.md) — and React is where the scheduling is: its scheduler slices work on a `MessageChannel`, it
batches renders and runs effects in its own order, and Strict Mode runs them twice. That's the event loop's boundary
(MODULES.md: a package's async work runs on the host's loop) — a corner for a Node program, the centre for a React app.
(React mode had the same hole: tsval stepping the component while React scheduled natively.)

So an app's determinism comes from the page, not the interpreter: the page's sources of variation virtualized — its
clock, `Math.random`, timers, `requestAnimationFrame`, `MessageChannel` and `queueMicrotask` on one virtual loop the run
owns, as tsval's loop is; its inputs (clicks, keys, resizes) and its fetches' results delivered as events and recorded —
for every script in the page, React included. That's replay's approach (record a page's nondeterminism, play it back),
and it makes a page deterministic without stepping it. Stepping is then tsval's part, for the app's own files, on top:
the page's virtual loop is the one tsval's runs on.

What that doesn't reach: layout and paint (the browser's, deterministic for the same inputs in practice), Web Workers
and iframes in the app (each a page of its own to virtualize), WebSockets (an input stream, to record), WebGL and media
timing. Those are the apps' entries in *What can't run this way*.

## What can't run this way

The hope is none; the plan is as few as possible, each a named case with a reason, kept on a list here and shrunk.
A case that can't run on tsval runs natively on almostnode — the same session, the same controls, the same policy
asking at each gated call (almostnode's capability hook, the service worker), just without what only stepping gives
(values, step-back, cards) — and the margin says so where the values would be, without naming a runtime.

Known and suspected:

1. **A browser page's own code** — a previewed app. It runs in the browser, which is the point; observed, not stepped,
   until the page's virtual loop and tsval in the page (*Apps and determinism*).
2. **Too slow to interpret** — measured (step 0): not a build, a bundler or a server (their work is in packages, or
   light per request), but a program whose own code computes heavily — a simulation, a game's update loop. The answer
   is making tsval faster, not keeping a second world.
3. **Packages** are native already (MODULES.md: a package is never stepped) — inside the run, on almostnode, not a
   separate mode. Their own async work is on the host's loop, outside the deterministic one.
4. **What tsval doesn't support yet** — a syntax or a builtin it lacks. Each is a bug to fix, not a mode; the run falls
   back for that program until it's fixed, and says why. Found by step 0: a debug run's globals are ECMAScript's alone
   (tsval's `standardGlobals`) plus its stand-ins — no `URL`, `TextEncoder`, `Buffer`, `structuredClone`,
   `AbortController`, which a Node program has. A run's globals should be almostnode's (the program's `process`,
   `Buffer`, the web globals Node has), as its built-ins are (step 1).

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
as a way to run a program (it keeps the dev server); the *production* debugger in VS Code's picker and launch.json;
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
2. **Real effects.** An allowed call made for real through almostnode's shims, its result recorded; asking in the
   margin the only way; the script worker's popup path retired for runs.
3. **The terminal.** `node f` always a run: output and stdin in its terminal, its args, cwd and env; the regex no longer
   decides anything.
4. **Services and apps.** A run that listens opens its preview; `vite` and the dev server as runs; React mode retired.
   Then the page's virtual loop (*Apps and determinism*): its clock, randomness, timers, frames and channels the run's,
   its inputs and fetches recorded — every script in it, React included — and tsval stepping the app's own files on it.
5. **The fallback.** The cases that remain (from step 0, and what tsval lacks) run natively behind the same session,
   the margin saying values aren't there; each listed here with its reason.

## Open

- A fast path: whether case 2 is answered by making tsval faster, by stepping only what's under a breakpoint, or by a
  native run — and if native, whether a run can move between the two (native to a breakpoint, then stepped).
- Replay: a run's recorded results let it run again exactly — whether *Run again* is that, or a fresh run.
- Effects on step-back: travelling back past a real write doesn't undo it. Show where a run's real effects are, so
  stepping back past one is visible.
- A page's code stepped by tsval in the page, for apps (case 1).
