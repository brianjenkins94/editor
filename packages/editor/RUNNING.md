# Running: one way, in the debugger

How a program is started, whatever started it, and what happens when it reaches a call with real effects. Written
2026-10-07 from a survey of every way the UI could start one. Supersedes the two-mode plan (tsval for debugging, an
almostnode "production" mode for real runs): there is one mode, and it is the debugger.

This is the core's (packages/editor/ARCHITECTURE.md, *The rewrite, in place*). The runs a save reaches went with the
reduction: this file at the `full-editor` tag has how they ran, and the ledger's tombstones say what each was. The file you're editing also runs on its own, on a save or an interval, quietly and without effects
(RUNTIME-EVIDENCE.md, *Live runs*).

## Why

The survey found fourteen entry points and four runtimes, each entry point choosing by a rule of its own (a regex over
the source, a mention of `ReactDOM`, which button). One program, run from two places — or edited to add a
`setInterval` — ran in different worlds: inert effects and values, or real effects and none. The cause was that running
and debugging were two things, a debug run with values but no effects and a real run with effects but no values, and
every entry point picked one.

## The model

**Everything runs in the debugger.** There's one action, *Run*, and every way in (the play button above a code file, F5, the
terminal's `node`, an agent's `runs_tests`) starts the same session: tsval evaluating the program's own files on almostnode
(packages/tsval/README.md, *Modules*). A breakpoint stops it if there is one; stepping goes back as well as forward.
There's no *Run Without Debugging* that runs something else.
The top bar's Run menu has that action and the workspace's scripts, each a task in a terminal of its own, whose `npm run` starts a
`node` or a `vite` as any terminal's does; a script whose service is up shows its preview rather than starting a second.
A dev server is a session in Run and Debug as well, with Restart and Stop on the debug toolbar and what it says in the Debug Console:
not a run of it, as nothing in it steps.

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

**For agents**, a run is driven the way a person drives it (extensions/bridge/debug-control.ts, CLAUDE.md, *Agent tools*):
`debug_start` is Run, to where it first stops; `debug_step` the toolbar's steps; `debug_breakpoints` the gutter's, VS Code's
own; `debug_decide` a stop's buttons in the Margin; `debug_stop` Stop; `debug_state` and `debug_list` what the Call Stack and
Variables views show; and `margin_state` what the Margin shows of a file, its question too. Each is done through VS Code, so it
shows in the editor as a person's would. Live runs aren't for driving and aren't listed. `debug_explore` is Explore Orderings,
below, and `debug_start`'s `eventLoop` its lightbulb's Debug ordering.

## Explore orderings

A race is a program that can end more than one way, depending on which of its events comes first. tsval's event loop
chooses, at each point where more than one could come next (a call's answer in, or a timer due), and records what it chose,
so a run can be made again by its choices (`eventLoop.schedule`, packages/tsval/src/explore.ts). Explore Orderings, in the
menu above a code file (More Actions), runs the file once per way those choices can go, up to 100 runs (worker/explore.ts):

- **Every call is its stand-in**, answered at once, as a run of a given schedule's is: how long a real call takes isn't the
  program's to choose, and only what's in can be chosen.
- **What depends on the order is said on the line it's about** (explore.ts; no list, as nothing else is): each line that
  prints or throws differently in one ordering than another has a diagnostic saying what it does in each, a throw as a
  warning, and its lightbulb's *Debug ordering N* runs that one in the debugger, exactly that way, to step. A difference no
  line can be found for is said on the file's first line. One way to end is *No race*, said and gone.
- **An edit to the file takes them away**, as what they say may no longer be so.

A debugged ordering's calls are stand-ins too, so it goes the way it went when explored; a call the policy hasn't allowed
still asks at its line.

## Apps: recorded stops, not live ones

Stopping at a line and stepping from it needs whoever runs the code to be able to stop. tsval can, for everything it
runs, including a library's synchronous callback (by blocking its worker until the user goes on). A page can't:

- **Page code can't pause page code.** Only the browser's own debugger stops a page, and a page can't drive it: the
  preview's DevTools go through chobitsu, which can inspect a page but not stop it.
- **The page's main thread can't wait.** A worker can block until it's told to go on; the main thread can't.
- **The browser calls page code synchronously.** A listener, a custom element's lifecycle, an observer's callback, a
  getter the browser reads: each is called from the browser's own stack. Run every script in the page on tsval and a
  breakpoint in a click handler still can't stop. Every framework is built on event handlers, so none escapes it.

The other way to stop live is the app moved into a worker with its DOM proxied from the main thread (Partytown's way):
real pauses, but every synchronous DOM read a round trip, and what must be decided in the event (`preventDefault()`, a
controlled input's value, focus) decided too late. That's slower than the real page and different from it exactly where
people debug, and each framework touches the DOM its own way: more proxy, more gaps. Rejected.

**A breakpoint in a page is a recorded stop.** Each time its line runs, what's in scope (locals, arguments, `this`, the
stack, which event or render) is recorded and shown in the margin, a column per time it ran. The recording is the dev
server's instrumentation mapped back through the framework's source maps: framework-neutral, at the page's own speed,
in the real page.

**Stepping a recorded handler.** The page also records what the function was called with, what it closes over and what
each call it makes returns, and tsval runs the same function from there, fed those results, while the live page has
gone on: *Step a Recorded Stop*, in the palette and in the lightbulb on the stop's line. Replay at a function's grain
rather than the page's. Not yet: a method, and stepping into another of the program's functions (it's handed its result).

**How it's wired** (workbench/recorded-stops.ts): the editor's breakpoints go to every dev server (`preview.stops`), which
instruments a file with a stop whatever the evidence level and hot-updates it; the page runtime (previews/page-evidence.ts)
records each hit, the latest 20 of each stop, and reports soon after through the shell (`stops.preview`); the dev
server's session in Run and Debug (workbench/preview-session.ts) tells the Margin them as its values, each report in place
of the last, against the text of the version that ran. A dev server's session is a no-debug one, so the breakpoints are
read from VS Code, not given to it.

A page isn't replayed. A virtual loop for its clock, timers, frames and channels, its inputs recorded, would buy
stepping back through UI code, but stepping back needs stopping first. Not planned.

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

`runs_affected` reads what each test last ran (`.silo/local/reach/`: each test's lines of each file it ran, this machine's),
and the table of features and tests shows the same: a file whose code has changed since it last ran is *touched*.

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

## Rules

A call's decision is on the call. The capability diagnostic says how it's decided and by what (`Denied by your rule: …`,
`Undecided: a run stops here and asks`), the same way a run decides it, and is as loud as that asks for: denied is an
error, undecided (and dangerous) a warning, skipped an information, allowed a hint, so Problems holds what's refused or
waiting on someone. Its lightbulb decides it: allow, skip or deny always, take out my rule, or open the rule
(extensions/capabilities/decisions.ts). The whole list, for when it's wanted, is the policy file, with each rule's sentence
above it (*Capabilities: Open Rules*). A rule is in `.silo/policy/<you>.json` or the shared `.silo/policy.json`; mine go first
and the first that matches decides.

A rule that isn't just that call is picked (extensions/capabilities/rule-picker.ts), from the lightbulb or a stop's *Rule…*: what
it covers (just this, a folder it's in, its site, its program, or every call of its capability), then what happens (allow, skip,
deny, or give a value: the call isn't made and returns what's typed, starting from what it returned last). A stop's *Give…* does
that for this call only. Anything more particular is an edit to the file, which its schema checks and completes.

A value is mocked from the lightbulb on its line (extensions/margin/mock.ts): a variable now, at a stop, as code could (not a
const), or on every run, by a rule placed on the line; `process.argv` on every run, by a rule about the program, unless the launch
gives its own. A placed rule is tied to the statement, not the line number. As a run launches its places are looked for in the
file as it is (extensions/bridge/placed-rules.ts), and each is armed as a breakpoint that isn't a stop: the statement runs, then what
the rule sets is set, const or not (extensions/tsval/worker/session.ts). It shows as a mark in the gutter with its sentence on hover,
as the value in the Margin, and as an information on the line. A place that's lost or only uncertain doesn't apply, since it might be
the wrong line, and says so as a warning in the file: the lightbulb puts it back where the cursor is (extensions/margin/placed.ts).

A preview's outside calls are decided the same way (extensions/bridge/preview-gate.ts), so it can't reach out unseen: a fetch or an
XHR by the service worker, a WebSocket or a peer connection by what it puts first in each page (shared/socket-gate.ts), both asking
the bridge. What the policy leaves undecided its window asks, there on the app (shell/preview-ask.tsx), and the answer holds for that
site until the server stops, or always, as a rule about the site. A preview nobody's watching (its windows collapsed or closed, or its
tab hidden) is given what the call returned last time, or refused, and asked when someone is. It fails closed. Not asked about: what a
page loads (its scripts, images and packages), a socket to its own machine, and what a worker of the page does.

There's no view of calls or of rules to go and look at: the previous iteration had them (Capability Calls, Rules, Exceptions)
and they were too out of the way and easy to ignore (the user, 2026-11-06). A decision made at a stop or in the file shows on
the call as soon as the file changes. What this gives up: findings are only worked out for what's open in an editor, so there's
no list of a whole project's calls, and a rule that matches nothing open is only seen in its file.

## What can't run this way

The hope is none; the plan is as few as possible, each a named case with a reason, kept on a list here and shrunk.
There's no fallback: a program that meets something tsval can't run **fails loudly**. The run ends there, saying what it
met (*Can't run this yet — the debugger doesn't support …*), marked on that line as a crash is, never dressed as the
program's own error and never naming a runtime. A second, native world would be a second set of behaviours to keep
honest, and it would hide each gap instead of making it a bug to fix.

1. **A browser page's own code**: observed, its breakpoints recorded stops (*Apps: recorded stops, not live ones*).
2. **Too slow to interpret**: a program whose own code computes heavily, a simulation or a game's update loop (*What it
   costs*). The answer is making tsval faster, not keeping a second world.
3. **Packages** are native already (packages/tsval/README.md, *Modules*), inside the run, not a separate mode. Their own
   async work is on the host's loop, outside the deterministic one.
4. **What tsval doesn't support yet**, a syntax or a builtin: each a bug to fix, not a mode.

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
