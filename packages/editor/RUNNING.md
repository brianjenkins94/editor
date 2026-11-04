# Running: one way, in the debugger

How a program is started, whatever started it, and what happens when it reaches a call with real effects. Written
2026-10-07 from a survey of every way the UI could start one. Supersedes the two-mode plan (tsval for debugging, an
almostnode "production" mode for real runs): there is one mode, and it is the debugger.

This is the core's (packages/editor/ARCHITECTURE.md, *The rewrite, in place*). Previews, rules, recorded stops in a page,
unattended runs and most of the Margin went with the reduction: this file at the `full-editor` tag has how they ran, and
the ledger's tombstones say what each was. The Margin is back for one thing: a run stopped at a gated call asks there, on
its line, until it's answered or the run moves on.

## Why

The survey found fourteen entry points and four runtimes, each entry point choosing by a rule of its own (a regex over
the source, a mention of `ReactDOM`, which button). One program, run from two places — or edited to add a
`setInterval` — ran in different worlds: inert effects and values, or real effects and none. The cause was that running
and debugging were two things, a debug run with values but no effects and a real run with effects but no values, and
every entry point picked one.

## The model

**Everything runs in the debugger.** There's one action, *Run*, and every way in (F5 on a file, the terminal's `node`,
an agent's `runs_tests`) starts the same session: tsval evaluating the program's own files on almostnode
(packages/tsval/README.md, *Modules*). A breakpoint stops it if there is one; stepping goes back as well as forward.
There's no *Run Without Debugging* that runs something else.

**What runs it is invisible.** The user never chooses a runtime, and nothing they see (a menu, an output pane, a run's
label) names tsval, almostnode or a worker.

**Effects are real, decided per call.** A call the policy allows happens for real, through almostnode's own shims and
the network. A call the policy hasn't decided stops at its line and asks (*Capability stops*, below): the one way a run
asks, no popups. A denied call fails as Node's would. Stand-ins remain only for a skipped or denied call.

**Deterministic.** tsval's event loop has a virtual clock, a seeded random and an ordering it can replay; its waits can
be skipped (*Skip Waits*) or made real. A run's globals are Node's, with what varies run to run the event loop's own:
`performance.now` is its clock, and `crypto`'s random numbers its generator. `BroadcastChannel` isn't there: this one reaches
every tab of the origin, the editor's own included.

**Output goes where it was started.** A run from the terminal prints there, reads its stdin there, and has the args, cwd
and env the command line gave; one from F5 uses the Debug Console. **What's running** is one registry (workbench/runs.ts):
each run as it starts and ends, a run that listens on a port a service, `ps` and `kill` in the terminal and `runs_list`
and `runs_stop` for agents.

## Tests

A test file is a program like any other: `node --test` in the terminal runs each file it's given (or every test file
under the directory, as node finds them) in the debugger, one after another, and fails if a test did. Breakpoints,
stepping and capability stops work in a test as anywhere. Decided 2026-10-23 (NEXT.md's decision c): tests run on
tsval, in the editor.

**`node:test` is the editor's** (extensions/tsval/node-test.js): JavaScript tsval runs as the program's own code, so a
test's awaits are on the run's deterministic event loop — a host-side runner calling guest tests would take them off
it. It isn't told as one of the program's files (no coverage, values or evidence of its own). It tells the debug
worker each test's start and end; the statements that ran in between, hooks and subtests included, are that test's.
What's there: `test`/`it`, `describe`/`suite`, `.skip`, `.todo`, the four hooks, a test's context (`diagnostic`,
`skip`, `todo`, `test`, `after`, `assert`) and callback tests. Not yet: `mock`, snapshots, `only` filtering, timeouts.

**For agents** (2026-10-29; workbench/test-runs.ts): `runs_tests` runs test files as `node --test` does and answers
each test as data. A failed assertion's sides come as node-test.js shows them; the time is the debug worker's clock,
since the program's own runs on the deterministic loop; and a test's outcome from before the run is beside it, so a
test that just broke reads apart from one that was already failing. A run waits for the editor to be up first
(workbench/readiness.ts: the workspace mounted, and the debugger able to take a run), and says what it's still waiting
on after 5 minutes. A gated call the policy leaves undecided doesn't wait on a person who isn't watching: the run ends
there and asks it through debug-mcp, as util/mcp's broker asks its own tools' (BERNARD's redline only as a
break-glass, JUDICIAL if it's set, else the person by MRTR); re-invoked with the approval, the run allows that call
once and goes on. And a call answers within 50 seconds, done or not (2026-10-31): a run still going answers with its
id, what it's doing and for how long, and the files done so far, and `runs_tests` with that `run` waits on it again.

`runs_affected` reads the tests' traces (`.silo/local/traces`: lib util/silo/traces, each test's run on each file it
ran), so the tests a change reaches are the ones whose last run here ran code in the changed files, each stale until it
runs again; the test files no trace names are listed apart. Nothing in the core writes traces now (their writer went
with runtime evidence), so until it comes back every test file reads as untraced.

**`@playwright/test` is the editor's too** (extensions/tsval/playwright-test.js): Playwright's test API over node-test.js, so a
Playwright test is told and traced as any other. Its `page` drives the preview you have open (the preview window used
last): packages/playwright's `Page`, `Locator` and `expect`, run in the debug worker (not stepped), each of a locator's ops
run on the preview's page by the shell (`playwright.run`, shell/preview-windows.tsx). An action waits for its element there
as Playwright's do, and an `expect` until it holds. What's there: `test` with `page` and `browserName`, `.skip` (declared, or
called in a test), `.fixme`, `.describe` and its modifiers, the four hooks, `step`, `info`. Not yet: `test.extend`,
`test.use`'s options, other browsers, contexts, `request`, timeouts, and `playwright` itself (a browser launched). With no
window open, a test fails rather than hangs, though what it says doesn't yet say why.

## Capability stops

A call the policy hasn't decided (a write, a fetch, a spawn) stops the run at its line, with what the call would do from
the run's own values (`writeFileSync '/workspace/out.txt' fs:write`), and is answered with `editor.capability.decide`
(extensions/bridge/capability-stops.ts): allow, skip or deny, each for this call, this run or always (a rule in my
policy, `.silo/policy.json`, for the resource the call reaches). *Skip*: the call isn't made, and the run goes on with
the debugger's inert stand-in's result. A capability line is armed from the source alone, so a stop checks the call's
actual resource against the policy and goes on when it's allowed. How a call is decided, a package's included, is
ARCHITECTURE.md, *Capabilities*.

## What can't run this way

The hope is none; the plan is as few as possible, each a named case with a reason, kept on a list here and shrunk.
There's no fallback: a program that meets something tsval can't run **fails loudly**. The run ends there, saying what it
met (*Can't run this yet — the debugger doesn't support …*), marked on that line as a crash is, never dressed as the
program's own error and never naming a runtime. A second, native world would be a second set of behaviours to keep
honest, and it would hide each gap instead of making it a bug to fix.

1. **Too slow to interpret**: a program whose own code computes heavily, a simulation or a game's update loop (*What it
   costs*). The answer is making tsval faster, not keeping a second world.
2. **Packages** are native already (packages/tsval/README.md, *Modules*), inside the run, not a separate mode. Their own
   async work is on the host's loop, outside the deterministic one.
3. **What tsval doesn't support yet**, a syntax or a builtin: each a bug to fix, not a mode.

## What it costs

Measured 2026-10-07 (`bench/running.ts`, Node 24, median of 5): the same program natively on almostnode, on tsval, and
on tsval as the debug worker runs it (coverage, profile, observed sites, the value trace).

| Workload | native | tsval | the debugger's |
|---|---|---|---|
| The program's own tight loops (primes < 20k) | 0.5ms | 1.1s (×2200) | 1.5s (×3000) |
| 20k records through map, filter, sort, JSON | 5ms | 250ms (×49) | 363ms (×72) |
| A server: 500 requests, a small JSON handler | 0.9ms | 38ms (×41) | 55ms (×60) |
| Build-like: the work in a package | 0.7ms | 0.9ms (×1.2) | 0.7ms (×0.9) |

Ordinary program code runs 40–70× slower than native, and tight numeric loops (what V8 compiles to machine code)
thousands of times slower. The debugger's instrumentation adds about 40%. But a package's work is native under tsval, so
a build, a bundler or a type-check costs nothing more, and a request is a tenth of a millisecond, so a server answers at
an interactive pace. Speed isn't the aim; this is where a fallback would be felt first, and where making tsval faster
pays (done once: ~2.8×, 2026-10-07).

## Another interpreter

What Run starts is a debug type, `run.debugger`, tsval by default. Another extension's debugger can be it (one built
from editor-contrib's `contrib/`, loaded by URL). It reaches the editor only through the run contract
(packages/editor-api), the Debug Adapter Protocol and the policy (`__policy`, `ask`, `decide`), as tsval does. What
stays tsval's: a terminal's `node` (it's Node's semantics).

## Open

- A fast path for case 1: tsval faster, or a compiled tier (packages/tsval/README.md, *A compiled tier*, parked until a
  program is too slow).
- Step-back past a real write doesn't undo it: show where a run's real effects are.
- A package's own calls: its network is the worker's, unasked.
