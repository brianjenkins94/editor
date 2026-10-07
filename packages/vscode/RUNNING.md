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
same margin). React mode — tsval rendering a component into a window of its own — gives way to the real preview.

## What can't run this way

The hope is none; the plan is as few as possible, each a named case with a reason, kept on a list here and shrunk.
A case that can't run on tsval runs natively on almostnode — the same session, the same controls, the same policy
asking at each gated call (almostnode's capability hook, the service worker), just without what only stepping gives
(values, step-back, cards) — and the margin says so where the values would be, without naming a runtime.

Known and suspected:

1. **A browser page's own code** — a previewed app. It runs in the browser, which is the point; observed, not stepped.
   Stepping it would mean tsval in the page (a later question).
2. **Too slow to interpret** — a build, a bundler, a heavy server. To be measured (step 0): if tsval is too slow for
   what people run, this is the biggest case, and the answer is making tsval faster, not keeping a second world.
3. **Packages** are native already (MODULES.md: a package is never stepped) — inside the run, on almostnode, not a
   separate mode. Their own async work is on the host's loop, outside the deterministic one.
4. **What tsval doesn't support yet** — a syntax or a builtin it lacks. Each is a bug to fix, not a mode; the run falls
   back for that program until it's fixed, and says why.

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

0. **Measure.** tsval against native almostnode on what people run: a script, a server under load, a build. The answer
   sizes case 2 above, and says whether a fallback is a corner or a road.
1. **One Run.** Every entry point onto one path — `runs.begin`, then a tsval session — with errors shown. The shell's
   and editor's buttons and the left rail run the file in the editor, program files only; the production picker entry
   goes. (The terminal still routes, until step 3.)
2. **Real effects.** An allowed call made for real through almostnode's shims, its result recorded; asking in the
   margin the only way; the script worker's popup path retired for runs.
3. **The terminal.** `node f` always a run: output and stdin in its terminal, its args, cwd and env; the regex no longer
   decides anything.
4. **Services and apps.** A run that listens opens its preview; `vite` and the dev server as runs; React mode retired.
5. **The fallback.** The cases that remain (from step 0, and what tsval lacks) run natively behind the same session,
   the margin saying values aren't there; each listed here with its reason.

## Open

- A fast path: whether case 2 is answered by making tsval faster, by stepping only what's under a breakpoint, or by a
  native run — and if native, whether a run can move between the two (native to a breakpoint, then stepped).
- Replay: a run's recorded results let it run again exactly — whether *Run again* is that, or a fresh run.
- Effects on step-back: travelling back past a real write doesn't undo it. Show where a run's real effects are, so
  stepping back past one is visible.
- A page's code stepped by tsval in the page, for apps (case 1).
