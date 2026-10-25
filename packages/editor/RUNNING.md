# Running: one way, in the debugger

How a program is started, whatever started it, and how a rule says what happens when it reaches something (*Rules*).
Written 2026-10-07 from a survey of every way the UI could start one. Supersedes the two-mode plan (tsval for debugging,
an almostnode "production" mode for real runs): there is one mode, and it is the debugger.

## Why

The survey found fourteen entry points and four runtimes, each entry point choosing by a rule of its own (a regex over
the source, a mention of `ReactDOM`, which button). One program, run from two places — or edited to add a
`setInterval` — ran in different worlds: inert effects and values, or real effects and none. The cause was that running
and debugging were two things, a debug run with values but no effects and a real run with effects but no values, and
every entry point picked one.

## The model

**Everything runs in the debugger.** There's one action, *Run*, and every way in (the shell's ▷, the editor's ▷, the
left rail, the terminal's `node`, a task, the margin, an agent) starts the same session: tsval evaluating the program's
own files on almostnode (packages/tsval/README.md, *Modules*). Live values, cards, coverage and the run log are always
there; a breakpoint stops it if there is one. There's no *Run Without Debugging* that runs something else.

**What runs it is invisible.** The user never chooses a runtime, and nothing they see (a menu, an output pane, a run's
label) names tsval, almostnode or a worker.

**Effects are real, decided per call.** A call the policy allows happens for real, through almostnode's own shims and
the network. A call the policy hasn't decided stops at its line and asks in the margin (Allow once, this run, always,
Deny, Rule…): the one way a run asks, no popups. A denied call fails as Node's would; a mocked one gets what its rule
gives. Stand-ins remain only for a denied or mocked call and for a probe's fork.

**Deterministic.** tsval's event loop has a virtual clock, a seeded random and an ordering it can replay. A real
effect's result enters the run as an event and is recorded at its seam (*A call's result*), so a run can be run again
exactly. A run's globals are Node's, but not what varies run to run (`performance`, `crypto`).

**Output goes where it was started.** A run from the terminal prints there, reads its stdin there, and has the args, cwd
and env the command line gave; one from a button uses the Debug Console. **A service is one too**: a run that listens is
alive while it's held, and its port opens a preview window, as `npm run dev` does.

**Apps.** A web app's own code runs in the preview's page, not in a worker: its DOM, layout and events are the
browser's. Its dev server is a program like any other; the page is observed (RUNTIME-EVIDENCE.md) and its fetches
decided at the service worker, in the same margin. React mode (tsval rendering a component on a fake DOM) gave way to
the real preview, as the source regex deciding the runtime gave way to Run (`lifecycle.ts`'s guess is only a label now).
The *production* debugger is hidden from the picker; its adapter stays only to show a preview's dev server as a session,
run control without stepping (extensions/bridge/production-adapter.ts).

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
gone on. Replay at a function's grain rather than the page's. Not yet: a method, and stepping into another of the
program's functions (it's handed its result).

A page isn't replayed. A virtual loop for its clock, timers, frames and channels, its inputs recorded, would buy
stepping back through UI code, but stepping back needs stopping first. Not planned.

## Unattended runs (designed 2026-10-22; partly built)

**Built (2026-10-22), on live runs** (RUNTIME-EVIDENCE.md, *Live runs*): they run on a save and on an interval; every
gated call's subject carries `trigger`; a call a live run would skip is given what it returned when it last ran for
real, if that's recorded; its line has *Rule…*; and each run is kept, a ball you can pick. **Built (2026-10-23):**
selection for tests — a save runs again, live and one at a time, each test file whose tests' traces on the saved file
hold a declaration its text no longer has (running/live-run.ts `reachedRuns`); an edit cancels what's queued. Those
runs are unattended (`__unattended`): a call no recording covers halts the run before it, its line saying so, with
*Rule…* and *Pin…* (the Margin's `margin.pin`: the values past runs saw there, picked one kept as a rule). **Built
(2026-10-24):** a program's run is kept on each workspace file it imported too, by the declarations it ran there (lib
traces' `program`: that program's latest, as a test's), so an edit to a module selects the programs that ran what
changed. Not yet: CI's selection (ambient code → the smoke suite). Decided: in a live run (the
file in front of you, its skipped lines marked) a call with no recording is **skipped**; a run you aren't looking at
**halts** (below). Recordings are keyed by the whole request (built 2026-10-23: editor-api gate.ts `requestOf`, a
method and a hash of the body beyond a plain read's URL). And each live run has a writable layer of its own (built
2026-10-23: editor-api runtime.ts `layered`).

Runs the editor starts on its own after an edit, so you see how a change affects what already ran without pressing
Run, and without a testing UI. They're runs like any other: the same session, margin, run log and evidence. The
difference is that nobody is watching, so nothing can stop and ask, and nothing may happen in the world that the
developer wouldn't have let happen.

**What runs.** What was run before, run again. A run's envelope keeps its entry, arguments and directory. Its evidence,
and the tests' reach (packages/silo/README.md, "Which tests reach what"), say which earlier runs reached the
declarations an edit changed. Those runs, and the tests that reach those declarations, run again once the edit
settles: one at a time, each new edit cancelling what's running. Code that no run reached starts nothing.

**Nobody is asked.** The policy decides every call, and who started the run is one of the facts a rule matches
(*The `trigger` target*). Where the policy would ask, the run halts instead: it ends before the call, without making it.
The question waits on that line in the margin until you're back. It says what the run reached, and offers what to do
when you're not watching: give what the call returned last time, skip it, allow it, or stop here. Your answer is a rule
like any other. So questions come only from runs that got that far, one per call, and nothing is set up front.

**Past runs are the default** (decided 2026-10-23). Where no rule covers a call, an unattended run gives it what it
returned the last time it ran for real (its recording), as live runs do already; only a call that never ran for real
halts. To keep a value instead, **pin** it: the call's line has a dropdown of the values past runs observed there, and
picking one saves a rule — *at this call, give that value* — so a pin is a rule, made without opening the rule editor
(*Mock…* opens it for any other value). File writes need no answer: a live run writes into a layer of its own.

**Skip or give.** Skipping a call is safe only where nothing reads what it returns, such as an `await fetch(…)` as a
statement of its own, which tsval can tell. Where the result is used, the run needs a recorded or given value, or it
halts.

**What it shows.** Nothing, when it runs as it did before. A difference is marked where it happens: a value at a site, a
throw, a failed test. So is a changed effect: a request that no longer matches its recording (*your edit changed the
body `checkout.ts` posts to /orders*), shown with the difference. Effects are compared, not asserted, so what a program
sends out is checked without anyone writing that check. A function observed pure (packages/silo/README.md, "Purity")
that returns something else for the same arguments is marked the same way.

**Shared, and in CI.** Recordings are this machine's (`.silo/local/recorded.json`: a response can hold secrets), so a
collaborator's unattended run halts where yours replays. Sharing one is explicit: *Save as rule* turns a recording into
a `give` in your policy file, choosing what to leave out, and the commit is where it's reviewed. CI is a trigger too
(`trigger is ci`): the same rules apply, and a halt fails the run, as everywhere nobody can be asked.

What it needs that isn't there:

- ~~**Recordings keyed by the request**~~ (method, URL, a hash of the body): built.
- ~~**`give result` for a preview's calls**~~: built 2026-10-24 (*A call's result*).
- ~~**A writable layer per run**~~, over the workspace's: built — in memory in the debug worker, over the editor's
  runtime files (editor-api runtime.ts `layered`), so the workspace's overlay stack needed no copy-up. A live run's
  write to a workspace file goes there (an effect decided `layer`), a read of what it wrote reads it there, and the
  layer goes with the run; a rule's *skip* still skips.
- **A home for runs nobody started.** The run log holds them; they don't take the Debug view's focus.

## Tests

A test file is a program like any other: `node --test` in the terminal runs each file it's given (or every test file
under the directory, as node finds them) in the debugger, one after another, and fails if a test did. Breakpoints,
stepping and capability stops work in a test as anywhere. Decided 2026-10-23 (NEXT.md's decision c): tests run on
tsval, in the editor, so what a test reaches is known by the same span ids as a run's, in the browser.

**`node:test` is the editor's** (extensions/tsval/node-test.js): JavaScript tsval runs as the program's own code, so a
test's awaits are on the run's deterministic event loop — a host-side runner calling guest tests would take them off
it. It isn't told as one of the program's files (no coverage, values or evidence of its own). It tells the debug
worker each test's start and end; the statements that ran in between, hooks and subtests included, are that test's.
What's there: `test`/`it`, `describe`/`suite`, `.skip`, `.todo`, the four hooks, a test's context (`diagnostic`,
`skip`, `todo`, `test`, `after`, `assert`) and callback tests. Not yet: `mock`, snapshots, `only` filtering, timeouts.

**A test is kept as a trace** (lib util/silo/traces' `test`: its id, the test file and its titles joined by ` › `, and
its outcome) on each file it ran: the top-level declarations it executed there, by BABLR span. So a file's traces say
which tests reach it, the record selection reads (*Unattended runs*: "What runs"). A file keeps each test's latest,
apart from its runs. Tests' traces are shared at a commit as runs are: those still current for the committed text.

**Features from tests** (Insights' Features view, built 2026-10-23; lib util/silo/test-features): the tests grouped by
the code they ran — not their own file's, which is test code — leaving out code at least half of ten or more tests
reach (ambient: setup, helpers), joined while their average Jaccard similarity is at least 0.5. A feature is named by
the suites its tests share, else their commonest title, and lists its tests (as each last came out) and its code where
it is now; a click goes to it. `insights.features` answers the same as data. A test file run alone and a whole
suite give the same grouping, since each test's latest trace counts.

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
stays tsval's: a terminal's `node` (it's Node's semantics), replay and orderings. test/contrib.mjs fails a change here
that breaks contrib/.

## Rules

One way to say what should happen when a program reaches something. Decided 2026-10-06: **one model, extending silo's
policy**; **our own model, JSON-compatible with ui-predicate and steered toward JSON Schema**.

**Why one model.** Each feature that decided something about a run grew its own UI: a capability stop's *Allow once* /
*Allow always* / *Deny* and the preview's prompt with the same three, the Capability calls panel's dispositions, Set
Value at a stop, the margin's Mock with *Persist* and *Multiple*, Run with Inputs' box of `|`-separated runs. Every one
is the same sentence: **when** the program reaches *this* (a call, an input, a line) and it *matches that*, **then** do
*something* (allow it, deny it, stop there, give it this value), once or always. Each new seam would otherwise add a
bespoke form to build, style, test and keep working. The pattern is old: macOS's predicate editor, Mail's rules,
Zapier's filters, rows of *target / operator / argument* combined *all* or *any*, and for rules a list of *actions*.

**The model** is ui-predicate's (targets, the operators each type offers, argument types, all/any), plus **actions**, so
a rule is `{ when, then }`. The targets, operators, argument types and actions are a **catalog** (lib
util/silo/policy.ts): adding a seam is adding catalog entries, not a form. A rule is applied now (*Just this once*) or
saved (*Save as rule*), the same two buttons wherever the editor opens; saved, it goes to the shared contract
(`.silo/policy.json`) or mine (`.silo/policy/<you>.json`). The one editor is core's (workbench/rule-editor.ts, vanilla
DOM: the workbench realm loads no Web Awesome, and a webview can't paint here), and it knows no targets.

**Stored as rows, compiled to JSON Schema** (decided 2026-10-06). Rows, ui-predicate's shape, because they round-trip
with the editor exactly and keep what was meant (*matches* `/workspace/**` stays a glob); a hand-written schema can use
keywords no row shows, and a glob kept as a schema is a regex or a custom keyword no standard tool reads. Compiled,
because then matching is schema validation by a standard validator (ajv), not an evaluator of ours, and the schema is
what's exported to other tools. Silo publishes the policy files' schema, so VS Code checks them by hand, and each
argument's input is drawn from its schema, as JSON Forms does, not a component per argument type.

**ui-predicate itself:** take its model, not its packages. The React adapter's peers are React 16/17 and it pins core
0.6.4; the core brings ramda, `option`, `error-ex` and Node's `events` for an editing API small enough to own, and has
no notion of actions. Revisit if its core grows actions or a vanilla renderer.

### A rule placed in the code

*at* is a target whose argument is a span reference (RUNTIME-EVIDENCE.md, *Durable annotations on spans*). The worker
arms each place as a breakpoint that isn't a stop: the statement runs, then the rule's *set*s (`variables.<name>`) are
made if it matches. A const can be set by a rule (Set Value at a stop still can't). A place that's lost or only
uncertain doesn't apply. A placed rule is a diamond in the margin's gutter, so a mocked value isn't invisible.

**A placed rule keeps its place on its own.** On save, it's followed through the edit history's bursts since the last
commit, one step at a time, by BABLR's structural diff. So an edit and the fix ESLint makes on save (`let` → `const`)
are two small steps, each followed exactly, where the two at once would be only a weak match. The shared contract's
rules are kept placed too: the one write silo makes to `policy.json`, a re-anchoring committed with the code that moved.

### A call's result

*give result* (a fetch's body, a read's contents) is given instead of the call, where something stands in for it: the
debugger's stand-ins return it, and since 2026-10-24 the service worker answers a preview's fetch with it, the network
untouched (a JSON body for a value, text for a string; `x-silo-given: rule`). A preview nobody's watching — none of its
windows on screen: its page's tab hidden, a dock tab behind another, collapsed (the shell's `capability.watched`) — is
an unattended run's, decided as `trigger is edit`: where the policy would ask, its fetch is given what it returned last
time (`x-silo-given: recording`), and one that never ran for real is halted (a 503 saying why, told once) — the
preview's reload on an edit among them (*Open*). (extensions/bridge/capabilities/decide.ts `decidePreviewFetch`.) *Rule…* at a stop starts from what the
call returned the last time it ran for real: a preview's allowed fetch and a run's allowed read, the latest of each, in
`.silo/local/recorded.json`, this machine's only (a real response can hold secrets). Commands aren't recorded:
almostnode's `child_process` is a stub.

### The `trigger` target

Who started a run is one of the facts a rule matches: `you` (any way in a person uses), `edit` (the editor, after an
edit settles) or `ci`. A rule can say what happens when nobody's watching (*trigger is edit*, …, *then give result*);
one without the row applies to every run. No new action: when nobody can be asked, `ask` (and `stop`) **halt** the run,
and the question waits on its line (*Unattended runs*): *Rule…* prefilled with the call and *trigger is edit*, the
actions picked most as buttons. *Just this once* re-runs it with the answer; *Save as rule* keeps it. Under *ci*, a halt
fails the run. Built: the target; not built: halting.

## Open

- A fast path for case 2: tsval faster, or a compiled tier (packages/tsval/README.md, *A compiled tier*, parked until a
  program is too slow).
- Replay: whether *Run again* runs with a run's recorded results, exactly, or fresh.
- Step-back past a real write doesn't undo it: show where a run's real effects are.
- A package's own calls: its network is the worker's, unasked.
- What a recorded stop keeps of an object, and how one stop is told from another (the event, the render, the turn).
- Does a breakpoint condition become a rule's *when*, with *stop* its action: one model for stopping and deciding?
- Unattended runs (*Unattended runs*):
  - ~~**An app's unattended run.**~~ Decided 2026-10-24: the preview's reload on an edit (HMR) is the app's run. While
    the preview is shown someone's watching, and its fetches go as the policy says; while it's hidden it's unattended,
    each fetch given its recording at the service worker and one with none halting. A rule's given result answers a
    fetch either way.
  - ~~**How much runs after an edit.**~~ Decided 2026-10-23: everything selection picks, one at a time, a new edit
    cancelling what's still queued; no budget.
  - **A database client's calls as the boundary**, if replaying at the wire proves brittle: the members your code calls
    (from the baseline's join), not the requests they make.
- The `trigger` target:
  - **One target or a flag.** `trigger` with three values, or `attended` (yes or no), with CI an unattended run whose
    halts fail.
  - ~~**Whether halting deserves its own action.**~~ Decided 2026-10-24: no — a rule that says `ask` is that call:
    asked while someone's watching, halted when no one is.
  - ~~**Where defaults live.**~~ Decided 2026-10-23: past runs are the default — a call gets what it last returned for
    real, and only one that never ran for real halts; pinning a value past runs saw is a rule (*Unattended runs*).
  - ~~**Matching a recording.**~~ Built 2026-10-23: a recording is keyed by the whole request — its capability and
    resource, and for anything but a plain read its method and a hash of its body (editor-api gate.ts `requestOf`,
    `recordingKey`), so a POST's isn't given to a GET of the same URL. A rule still matches by capability and resource;
    a target for the request (`request.method`, `request.body`) waits for a rule that needs one. A preview's fetch,
    recorded at the service worker, is keyed as a read.
