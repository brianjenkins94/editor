# tsval

A **stepped, stack-based, TypeScript-AST interpreter**. It walks the native TypeScript compiler AST
(`ts.SyntaxKind`, "Path B") and executes it on an explicit continuation-stack VM — not host recursion
— so it can single-step, pause/resume, and snapshot/fork execution state.

This repository is the interpreter only. It exposes the seams a host builds on — a host-boundary
guard that sees every value and every callable crossing from the host, an `import` resolver, an
async-invocation hook, fork, breakpoints, an optional TypeChecker — and takes no position on what a
host does with them. (The capability canary that originally motivated those seams lives in its own
repository.) *A compiled tier* (below) is parked; how the editor hosts tsval is in
`packages/editor` (RUNNING.md; RUNTIME-EVIDENCE.md, *Live values*), and how its modules load is *Modules*, below.

## Requirements

Node ≥ 24 (runs `.ts` natively — no build step).

```bash
npm install
npm test            # unit + differential oracle
npm run typecheck   # tsc --noEmit
```

## Usage

```ts
import { interpret, createVM } from "./src/index.ts";

// Run to completion (returns the last expression's value).
interpret(`const a = 1; const b = 2; a + b`); // => 3

// The guest sees only the standard built-ins unless a host adds more.
const seen = [];
interpret(`fetch("https://x")`, { globals: { fetch: (u) => seen.push(u) } }); // without `globals`: ReferenceError

// Single-step and inspect the machine between steps.
const { vm } = createVM(`const n = 1 + 2; n * 10`);
while (!vm.finished) {
  vm.stepStatement();          // or vm.step() for one unit of work
  console.log(vm.values, vm.frames.length);
}
vm.completion; // => 30
```

## Supported surface

tsval runs **strict-mode ECMAScript plus erasable TypeScript** — the language a TypeScript *module*
is written in, and the surface Node's own type-stripping accepts. Anything outside that is refused
**loudly** (a `TsvalInternalError` naming the construct), never silently mis-run:

- Strict-mode semantics throughout: top-level and plain-call `this` are `undefined`; assigning to an
  undeclared name is a `ReferenceError` (no implicit globals); a function declaration in a block is
  block-scoped; `undefined`/`NaN`/`Infinity` are read-only.
- Out of scope by policy: sloppy-mode-only behavior (`with`, implicit globals, function-in-block
  lifting), legacy `experimentalDecorators` (non-standard; standard TC39 decorators are not modeled
  either, and sharing their syntax is exactly why neither is half-implemented), parameter properties,
  `namespace`, `import =`.
- Retained non-erasable construct: `enum` (runtime-emit, differentially verified against `tsc`).
- **A program sees only what it is given.** The default global object is ECMAScript's standard
  namespace (`standardGlobals()`: `Object`, `Math`, `JSON`, `Promise`, `Intl`, …) and none of the
  host's — no `process`, `require`, `fetch`, timers or `console`, and no `eval`. A host adds what it
  wants through `globals`, supplies a whole realm through `globalObject`, or asks for the host's
  real `globalThis` with `realGlobals: true` (what the differential oracle does, for parity with Node).

The differential oracle runs Node in strict mode with an undefined receiver to match.

## Host seams

```ts
import { interpret, createVM } from "./src/index.ts";

interpret(code, {
  hostGuard: {
    sanitize: (value) => value,                 // every host→guest value crossing (property reads, returns, awaited values)
    beforeCall: (callee, thisArg, isNew, site) => callee, // every host callable the guest invokes: replace, wrap, or refuse;
                                                    // `site` = the callsite node and the evaluated args
  },
  resolveModule: (specifier) => namespace,      // what `import` / `import()` resolve to
  onAsyncFiber: (promise) => {},                // every async function / async-generator invocation
  steppedAsync: true,                           // async code on the main stack, steppable (below)
  eventLoop: { now, seed, pace: "real" },       // …with a deterministic event loop of its own: timers, clock, random (below)
});

const { vm } = createVM(code);                  // { vm, sourceFile } — the typed layer returns the same shape plus the checker
vm.runUntil((m) => m.steps > 1_000);           // step budgets, breakpoints (vm.location, vm.breakpoints)
const fork = vm.fork();                        // an independent copy of the machine state, mid-expression if need be

// Type-aware — a separate, opt-in layer (`@brianjenkins94/tsval/typed`); the interpreter itself knows no
// TypeChecker. A guard's callsite then carries the static types (returnType(), signature(),
// argumentType(i)), so it can answer a host call with a stand-in shaped like the call's DECLARED result.
import { createTypedVM } from "./src/typed.ts";
const { vm: typed, checker } = createTypedVM(code, { hostGuard: { beforeCall: (callee, _t, _n, site) => (site.returnType() ? () => shapeFrom(site) : callee) } });
```

With `steppedAsync`, async code runs where a host steps: an async function runs on the main stack until its first
`await`, where its frames are cut off as a pending fiber; when what it awaited settles, the fiber is a job the machine
resumes once its stack is empty, in the order things settled. A guest callback handed to a host promise
(`then`/`catch`/`finally`) is a job too, and a top-level `await` suspends the program the same way. So breakpoints,
`stepStatement`, `runToBreakpoint` and `fork()` reach into async code — a fork copies its pending fibers, and resumes
its own. With work pending and none ready the machine is `idle`: the host awaits `vm.whenSettled()` and steps on.
Without it (the default), fibers run on the host's promise queue, each to its next suspension at once.

```ts
const { vm } = createVM(code, { steppedAsync: true });
vm.addBreakpointsByLine(12);                   // a line after an await
for (vm.runToBreakpoint(); vm.idle; vm.runToBreakpoint()) {
  await vm.whenSettled();
}
```

With `eventLoop` (it implies `steppedAsync`) the machine has an event loop of its own, deterministic: `setTimeout`,
`setInterval`, `setImmediate`, their clears and `queueMicrotask`, with Node's ordering — the promise jobs that settled,
then timers by due time on a **virtual clock**, each callback a steppable job on the main stack. The clock moves only
as timers fire (to their due time); `Date` and `Date.now()` read it, and `Math.random()` is seeded. So the same program
from the same `now` and `seed` runs the same way every time, and so does every fork: a debugger's step forward from a
stop it travelled back to goes the way it went. `pace` is what a wait costs — `"real"` (default) waits each timer's real
delay, `"fast"` none — never the order. The timers, clock and random generator are intrinsics acting on the machine
that calls them (a fork's guest code reaches the fork's), ahead of `hostGuard`.

```ts
const { vm } = createVM(code, { eventLoop: { now: 0, seed: 42, pace: "fast" } });
// setTimeout(() => log(Date.now()), 50) logs 50 — every run
```

A promise a host call returns (a fetch, a file read) is **external**: the guest gets one of its own, settled only when
the result's arrival is delivered as an event between tasks — so nothing, not even `Promise.race`, sees it early. Where
several events could come next (two results in, or a result and the next timer), which does is a **choice**: the first by
default (results in the order they were asked for, then the timer), or `eventLoop.choose`'s, recorded in `vm.choices`,
and replayed by `eventLoop.schedule`. `explore` runs every schedule there is, depth-first, and returns the distinct
outcomes, each with a schedule that reaches it — a race is outcomes that differ (the editor's *Explore Orderings*).

```ts
import { createVM, explore, runToEnd } from "./src/index.ts";
const found = await explore(async (schedule) => {
  const { vm } = createVM(code, { globals, eventLoop: { now: 0, seed: 1, pace: "fast", schedule } });
  await runToEnd(vm);
  return { outcome: lines.splice(0), choices: vm.choices };
});
// found.outcomes: [{ outcome, schedule, choices, runs }, …] — run one again with eventLoop.schedule
```

Guest→guest calls never touch the host stack, so a guard cannot be bypassed from inside the guest;
`[].constructor.constructor` reaches the guard like any other read.

## Modules: almostnode resolves, tsval evaluates

How the editor finds and runs a program's modules, the same way whether it's run or debugged (2026-10-07; built). A
first cut made tsval the host: the debug worker gave the entry its own `require`, and a tsval resolver decided per
specifier, so there were two module systems that could disagree (on `exports`, extensions, cycles, the cache), and the
program's other files ran natively, unstepped.

**almostnode is the runtime**: module resolution, the graph and the cache, for a run and a debug run alike. **tsval is
an evaluator** it hands the program's own files to — files under the workspace, outside `node_modules`. A package is
never stepped; a program file always is, entry or not. Packages and built-ins are always native.

- **almostnode** (`Runtime`, 0e8c9d8): `resolve(specifier, from) → { kind: "builtin" | "package" | "program", filename }`
  (Node's algorithm, callable on its own); `loadNative`; an **evaluator hook** for `program` files; and `register
  (filename, module)`, so a module tsval evaluated is one instance for everyone (a framework reading the user's config
  gets the program's `exports`). A package requiring a program file calls the hook synchronously, and tsval runs the
  file in a nested run, stepped only through a breakpoint in it. **Built-ins by who asks**: `require("fs")` from a
  program file in a debug run is the capability stand-in (inert, gated); from a package, the real shim with writes
  refused. The stand-ins are almostnode built-in overrides for program files.
- **tsval** (src/modules.ts): a machine over several files. A frame knows its file (`location()` is `{ file, line,
  character }`; breakpoints, `coverage`, `profile`, `trace`, `observe` and `throwSite` by file). A module frame's scope
  holds `module`, `exports`, `require`, `__filename`, `__dirname`. `require` is an intrinsic: a program file not yet
  cached is registered (its `exports` before it runs, so cycles see the partial one) and its frame pushed **on the main
  stack** — stepping goes into it and a fork carries it; anything else loads natively. ESM: program-file imports
  evaluate first, depth-first, each once, then bind; ES exports are getters on `module.exports`. The loader is an
  interface (`VMOptions.modules`: `resolve`, `loadNative`, `register`), so tsval knows nothing of almostnode; a host
  with none keeps single-file behaviour.
- **The editor's debug worker** starts the entry through almostnode with tsval as evaluator (loading almostnode costs a
  launch ~30 ms); the workspace buffer comes in the launch. Each file's values, cards, run log, coverage and evidence
  are its own (a live record per file; each file that ran folded into its own `.silo/evidence` file). One runtime setup
  (`shared/workspace-runtime.ts`) serves every run: one cwd, deploy base and built-ins, a listening server found and
  answered one way. What stays per run is policy (fs calls asked about, stand-ins) and its event loop.

**The event loop's boundary.** tsval's deterministic loop covers stepped code. A package's own async work (its timers,
its promises) runs on the host's loop: what a package does between the program's calls into it isn't the program's to
order. A package's callback into a program function runs as a nested job.

Open: an importer binds a named import when it links, not live as ESM's bindings are (a namespace import reads live);
a file's run log counts its own steps, so a call's line in the importer doesn't include the work in the file it calls;
capability stops and placed rules are per file, armed as it loads, but `process.argv`'s row and Mock stay on the entry.

## A compiled tier (parked)

Parked. Whether tsval should have a second, compiled tier beside the frame machine, and how the two would hand off. Written
2026-10-07 as a feasibility study: a prototype measures the ceiling (`bench/compile-ceiling.ts`); nothing here is built
into `src/`. Re-measured after the frame machine's own speed-ups of the same day (operands evaluated in their parent's
step, no scope or `arguments` object nothing uses, cheaper host→guest callbacks): it ran compute 252→109ms, so the
ratios below are against that.

### Why

Every program the editor runs runs on tsval, in the debugger (packages/editor/RUNNING.md). Its *What it costs* found
ordinary code 40–70× slower than native and a program's own tight loops thousands of times slower, and named "too slow to
interpret" — a simulation, a game's update loop — as the case that falls back to running natively without values. Its
answer was "making tsval faster, not keeping a second world". A compiled tier is the large version of that answer: the
frame machine pays a frame push, a dispatch and a phase switch for every node it evaluates, every time; a closure
compiler pays them once per node, at compile time.

### The ceiling

The prototype compiles each node once into a JS closure — an expression to `(env) => value`, a statement to
`(env) => signal` — with identifiers resolved at compile time to (depth, slot). A guest function is a real JS function,
so a host calling it back (`map`, `filter`, `sort`) calls compiled code directly. It covers what the harness's three
programs use, and refuses anything else. It pays what a real tier would have to: host calls through invokeHost's checks,
host values through `fromHost`, TDZ checks where a read can't be proven after its declaration, `const` assignment
refused. All engines agree on every result; compiled tracing tells exactly the events the frame machine's does (same
counts, kind by kind).

Node 24, each engine on each program in a process of its own, the second-best of 4 taken twice, the lower kept:

| | native | frames | frames, debugger options | closures | closures over today's `Scope` | closures, counted | closures, traced |
|---|---|---|---|---|---|---|---|
| compute (primes < 20k) | 0.5ms | 109ms | 155ms | **8.6ms** (12.7×) | 23.7ms (4.6×) | 11.0ms | 19.4ms (8.0× the debugger's) |
| data (20k rows: map, filter, sort, JSON) | 6.2ms | 62ms | 96ms | **16.6ms** (3.7×) | 21.2ms (2.9×) | 16.8ms | 22.5ms (4.3×) |
| objects (a class, 30k `new`, for…of) | 3.5ms | 126ms | 160ms | **14.3ms** (8.8×) | 23.6ms (5.3×) | 15.5ms | 20.2ms (7.9×) |

- *closures*: resolved slots, nothing else — the ceiling.
- *over today's `Scope`*: the same closures reading and writing the frame machine's own `Scope` objects (names looked up
  in maps, as its handlers do). What compiling is worth if both engines keep sharing scopes as they are.
- *counted*: plus what step-indexed features need at statement grain — a statement count, coverage (a counter per
  statement) and a breakpoint poll at each statement start.
- *traced*: plus the value trace (`VMOptions.trace`), with each event's call number and loop turns kept in a side stack.
  (The debugger column also has the profile and observed sites; those compile to the same kind of counter.)

Parse is 0.2ms and compiling all of compute 0.05ms: compile cost doesn't decide the tiering policy.

**Compute gets the big win; data and objects a real one.** Compute is the program's own arithmetic and loops — all
interpretive overhead, so it falls by ~13×, to ~16× native. Data is bounded by what's native in it already: `Array.from`,
`filter`, `sort` and `JSON` are 6ms of V8 that neither engine touches, and what's left is object literals and spreads in
the callbacks. The host-callback boundary is not the cost — a host calling a guest callback through `runSub` is 0.32µs
in the frame machine, cheaper than a guest→guest call (0.41µs); the callbacks' *bodies* are. Objects sits between:
property reads and writes, `new`, method calls, all compiled. In a long-lived worker running every program, the closures'
call sites see every shape of closure and their feedback is shared: measured in one process, up to 1.5× slower than the
table (`bench/compile-ceiling.ts mixed`).

**The debugger's consumers dominated before the engine did** — fixed since. The worker's trace consumer (debug-worker.ts
`traceValue`) cost more than the whole frame-machine run: `LiveRecord.add` re-listed its calls for every value of a call
past its bound (quadratic), and every event re-derived its node's line and range. With the count kept and each node's
place cached, the real consumer adds ~+28% / 15% / 16% (compute / data / server) over a no-op one, down from 2.9–4.9×.
What's left is per event, so a compiled tier's gain in the debugger is bounded by the event rate, not the engine.

### What a real tier would cover

The prototype is about 1,000 lines, its four modes included, for some 25 node kinds and their operators. A tier worth shipping compiles **plain synchronous functions**:
everything but generators, `async`, `yield` and `await` (their activations must be suspendable data; they stay frames).
That's most of the handlers: references and operators, calls and `new`, literals and spread, `if`/loops/`switch`/labels/
`try`, destructuring (running the existing pattern programs, which are plain data), optional chains, templates, method and
constructor bodies (a class itself is still built by the frame machine; derived constructors' `super()` protocol last).
Roughly 2.5–4k lines, reusing realm.ts's helpers. It can grow one construct at a time, because a unit containing anything
it doesn't compile simply isn't compiled — refusal is always safe.

And it is testable: the differential corpora (test262's sample, TypeScript's cases, ts-evaluator's) run with every eligible
unit compiled eagerly, against Node, as they run the frame machine now. That's what keeps two engines from drifting, and
it has to stay as cheap to keep green as it is today.

### Tiering

- **The unit** is a function body (a plain sync function). Later, a loop statement, entered at its start, so a hot loop
  in top-level code or a `main()` called once still tiers up (a function called once never does by call counts).
- **When**: lazily, on a unit's first eligible entry. Compile cost is microseconds; there's no reason to wait N calls
  except memory for code that runs once.
- **Eligible** when the machine is *running* (`run`, `runToBreakpoint`, a host's callback) — never while stepping
  (`step`, `stepStatement`, a step-out) — and no armed line is in the unit: a breakpoint, a rule's set-hook, a capability
  line. Arming a line in a unit drops its compiled code.
- **Specialized** by the machine's options: coverage, profile, observe and trace compiled in or out. The debugger has all
  of them on; the capability canary in tsserver has none.
- **Entered** from the frame machine's call frame (phase 0: run the compiled body, push its value, pop — one step) and
  from the host-invoked wrapper (`callGuestFromHost` calls compiled code directly instead of a `runSub`, which is what
  makes data's callbacks cheap). Compiled code calls compiled code directly; anything else through `invokeHost`, or, for
  a guest function not compiled, `callGuestFromHost` (a nested frame-machine run).

### The engine switch

Getting *into* compiled code is easy: at a call, or at a loop's start, with the scope chain in hand. Getting *out* in
the middle — because a stop happened in a callee below it, or a breakpoint was set in it, or the user steps into it, or
something forks — is the hard part. A compiled activation lives on the host stack, which can't be stepped, paused
asynchronously or forked. Three ways out:

**(a) Never mid-function.** A compiled activation always runs to completion; a breakpoint set in a function running
compiled takes effect on its next call. What it costs depends on what can stop beneath compiled code. A guest function
compiled code calls without compiling runs in a nested `runSub`, so a stop there is what a stop in a host callback is
today: *atomic* — the worker blocks on Atomics.wait, no fork goes into history, no step back, no stepping past the
callee's end, and a call stack of the callee's frames alone. Acceptable only if it's rare. The rule that makes it never
happen: compile only while the machine has **no armed line at all**. Then nothing can stop while compiled code runs,
and at every stop the machine is all frames — every debugger feature works unchanged. Breakpoints set during a run arrive
only between tasks (the worker reads messages at stops and when idle), when no compiled activation is on the stack. The
one gap: a program file loaded mid-run arms its capability lines (`noteProgramFile`) under compiled code already
running — an atomic stop if one is hit before the activation returns.

**(b) Materialize frames.** On a stop beneath it, a compiled activation unwinds (an uncatchable exception) and rebuilds
itself as data on the frame stack. Into the frame machine's own `NodeFrame`s, that means a materializer per node kind and
phase — every handler's phase protocol mirrored in the compiler, coupled forever to a frame machine that is itself being
re-shaped for speed (leaf fusion changed its phases). The cheaper form keeps compiled activations in a format of their
own: call sites lowered to statements (A-normal form, temporaries in the activation), each statement kind given a
"resume at child *i*" entry (about ten kinds), and a `compiled` synthetic frame holding `{ unit, scope, resume path,
temporaries }` — plain data, so `fork()` clones it like a scope. Stops are full stops at once, effects never repeat. What
changes: stepping inside a compiled frame is at statement grain (`step` there goes to the next statement or call, not the
next node), and the compiler gets a second shape. Three to five weeks, with `try`/`finally` and iterator closing on
resumed loops the risky part.

**(c) Re-execute.** tsval is deterministic: the same fork, clock, seed and schedule run the same way, and time travel
already relies on it. A stop reached with compiled activations beneath it abandons the attempt (unwind, uncatchable) and
re-runs from the checkpoint — the fork the debugger advanced from, which it keeps pristine already — in the frame
machine, with the units that were on the stack barred from compiling, until the same point: the same statement at the
same count (its coverage). The stop is then an ordinary stop. Cost: the segment since the last stop, again, at
frame-machine speed — so never more than ~10% slower than today, and a breakpoint in a hot function, hit often, means
short segments. What it needs: effects in the abandoned attempt not to happen twice — the worker's gated calls served
from a log of what they returned (the seam packages/editor/RUNNING.md, *A call's result*, records at), output buffered
until the attempt is known to stand. What it can't fix: a package's own native state, mutated by the abandoned attempt,
isn't rewound — the caveat time travel already carries, but now met without the user stepping back.

| | (a) only while nothing is armed | (b) materialize | (c) re-execute |
|---|---|---|---|
| A full stop (fork, history, step back, Locals, set a value) | yes — no stop happens under compiled code | yes | yes |
| Stepping | frames only | statement grain inside compiled frames | frames only |
| A breakpoint set at a stop | at once (nothing compiled is on the stack) | at once (a checked variant) | at once |
| Capability stops, set-hooks | they're armed lines: their runs aren't compiled | yes | yes |
| Probes (fork at a stop, step to the call) | unchanged | unchanged | unchanged |
| Atomic stops in host callbacks | as today | as today | as today |
| Coverage, profile, observe, trace | compiled in | compiled in | compiled in; the abandoned attempt's thrown away |
| Explore Orderings (every schedule, to its end) | compiled | compiled | compiled |
| Effects exactly once | yes | yes | gated ones by log; a package's native state not rewound |
| Runs it speeds up | runs with nothing armed | all | all; a stop's segment runs twice |
| Size | small | large, coupled to stepping | small, plus the worker's log |

### Steps, time and step-indexed features

- **`steps` stops being a shared unit.** A frame step is an artifact of how the frame machine decomposes a node — leaf
  fusion just changed how many there are — and compiled code can't count them without paying for them. Several things
  key on `steps`: a trace event's `step` (the live-values margin orders by it, and `LiveRecord` drops an event from an
  earlier step as a replay after a step back), the profile's work per statement and first step, `maxSteps`. If the same
  stretch of code can run compiled on one timeline and as frames on another (tiering is per machine, compiled code is
  per node), those numbers diverge and the replay test misfires. The engine-independent clock is the **statement
  count**: incremented at every statement start in both engines — coverage's own points, identical by construction. The
  trace's `step`, the profile and a re-execution's target use it; `steps` stays the frame machine's fuel and budget.
  (Built: `VM.statements`. Several events share a reading now, so the live record tells a replay by an event's place
  among its statement's events too, and a run going on from a stop resumes that count from where the stop left it.)
- **Virtual time is untouched.** The clock moves only between tasks, as timers fire; a compiled unit runs inside one step
  of one task. `Date`, `Math.random` and the timers are intrinsics reached through `invokeHost`, the same values in either
  engine; the loop's choices are made between tasks, recorded and replayed the same.
- **Coverage, the profile and observed sites** are counters at points known when compiling (a statement's top-level
  statement is known statically), so they compile to array increments. Coverage is kept that way already — per file,
  a count for each statement by its index in source order (`VM.coverage`) — and the profile is tallied at the same
  points: a statement's start, plus a declaration's step and a concise arrow body's entry (`() => f(x)` stands for
  `return f(x)`; without it, a callback's work and its timer's wait would be no one's).
- **The trace** needs the call number and the loops' turns the frame machine reads off its frames; compiled code keeps a
  side stack (the prototype's). With every event told, tracing costs compiled code 1.7× — so the consumer's bounds should
  reach the producer: a tracer that can say "no more for this call" lets compiled code stop building events it would
  drop.
- **Async.** Compiled code is a host frame, and today a host frame between the main loop and an `async` call (depth > 0)
  takes that call off the deterministic loop onto the host's promise queue. A compiled caller must keep it on: run the
  async function's synchronous prefix nested, and at its first `await` cut those frames into a pending fiber of the main
  machine, as `cut()` does on the main stack. Needed before any unit that calls async code compiles.
- **Errors.** A throw out of compiled code is a JS exception; `advance` already turns one into a guest throw. Compiled code
  must note throw sites (crash reports), let uncatchable errors through its own `try`/`catch`, and turn host stack
  overflow — compiled recursion uses the host stack, as Node's does — into a guest `RangeError`.

### Recommendation

Worth building, in this order, if the slow-program case is real for users (RUNNING.md says it's where the fallback is
felt first) and the differential corpora can run every unit compiled as cheaply as they run frames. Start with (a) —
it needs no exit mechanism at all and keeps "at every stop the machine is all frames" — and add (c) to lift its
restriction. Reach for (b) only if re-executed segments prove too slow or the native-state caveat bites.

0. **Before compiling** — done 2026-10-07. The trace consumer's cost (above); the statement count as the shared clock
   (the trace's `step`, the profile, the run log's work); coverage counts in per-file arrays, not a map keyed by node.
1. **The closure tier over today's `Scope`** (~3 weeks). Plain sync function bodies, compiled lazily, entered from call
   frames and host wrappers, instrumentation specialized; only while the machine has no armed line (a). Shared scopes mean
   nothing to convert: a fork, the Locals view, setting a value and closures made by either engine called by the other all
   work unchanged. Expected: compute ~4.6×, objects ~5×, data ~3×, for runs with nothing armed — the slow programs, and
   every Explore Orderings run. The eager-compile differential mode lands with it.
2. **Resolved slots in both engines** (~2 weeks). Scopes become slot arrays with a names table per scope shape (the
   debugger's Locals reads names from it); both engines resolve identifiers to (depth, slot) once. The frame machine gets
   faster too; the compiled tier goes from the `Scope` column to the slots column (compute ~13×, objects ~9×, data ~4×).
   (Slots for the frame machine alone were measured not worth it: name lookup is ≤4% of its time once scopes nothing
   uses aren't made. Their case is the compiled tier's.)
3. **Stops under compiled code by re-execution** (c) (~1–2 weeks). Unwind, restore the continue's fork, re-run with the
   stack's units barred, stop at the same statement count; the worker's gated-call log and buffered output. Breakpoints
   and capability lines no longer turn the tier off.
4. **Later, by measurement.** Loop units for top-level loops and `main()`. Async calls from compiled code (above).
   Materialization (b), if (c)'s segments hurt. A source-code tier (`new Function`, per-site feedback, near native) would
   plug into the same units and the same exits — the switch designed here is the expensive part, and it carries over.

What would make it not worth it: if the corpora can't be kept green against two engines at today's cost, or if the
programs that are slow in practice turn out to be slow in their packages (native already) rather than in their own code.

## TypeScript's own test cases

The TypeScript repository's `tests/cases/{compiler,conformance}` (Apache-2.0, ~12k programs, pinned
to the `typescript` version tsval uses) are wired in as differential *inputs*: they test the
compiler and assert nothing at runtime, so tsc's emit running in Node is the oracle and tsval on the
TypeScript source is the subject. Single-file, non-module, syntactically clean programs within the
supported surface are eligible (~5.3k); the agreement is 99.9%, with the remaining cases listed by
reason in `test/differential/ts-cases-gaps.ts`. Cases run in a child process, because some of them
were never meant to run (one spreads an infinite iterator). A 1-in-10 sample is checked in and runs
in `npm test`; `npm run ts-cases:fetch` and `npm run ts-cases:report` run the full corpus.

## Conformance: test262

The official ECMAScript conformance suite ([tc39/test262](https://github.com/tc39/test262), BSD-3)
is wired in as an oracle, with Node as the control. The supported-surface policy is applied as a
*filter* on its metadata: `noStrict`, `module` and `raw` tests, parse-phase negatives, and host-level
features are skipped by policy; everything else must pass, be inconclusive (Node fails it too), or be
a listed known gap (run as `todo`).

- `vendor/test262-sample/` is checked in: a deterministic 1-in-25 sample of the eligible
  `test/language` tests (~650), run by `npm test` as an always-on regression corpus.
- `npm run test262:fetch` pulls the full pinned checkout (98 MB, gitignored) into `vendor/test262/`;
  `npm run test262:report` runs all ~16k eligible tests and prints failures bucketed by directory and
  reason — the dev loop for finding the next bug.

Each side of each test runs in a **fresh realm** (`node:vm` context): test262 mutates builtins on
purpose, and tsval creates guest values with the guest realm's intrinsics so `[] instanceof Array`,
`Object.getPrototypeOf({})`, `"".constructor` and a generator's prototype chain agree with the
guest's own `Array`/`Object`/`String`/`%GeneratorFunction%`.

test262's language tests are *scripts*, so the runner passes the realm's global object as the
top-level `this` (`VMOptions.thisValue`) and installs `$DONE` as a global property; tsval's default
remains module semantics (top-level `this` is `undefined`, top-level bindings are not globals).
Current standing on the full pinned corpus: **99.9 % of eligible tests pass**; the remaining 11
failures all concern exact microtask ordering (`await` interleaving, async-generator ticks), which
follows the host promise queue (`steppedAsync` keeps that order, settling jobs as the host's promises do).

Every destructuring pattern, parameter list and catch parameter is compiled once to a small list
of plain-data ops run by a synthetic `pattern` frame; defaults, computed keys and member targets
are ordinary node frames above it, so `const [a = yield] = it` or `[o[await k]] = v` suspend like
anything else, and a fork taken in the middle of a pattern is ordinary frame state.

## Layout

- `src/` — the VM (`vm.ts`), the frame types (`frame.ts`), scope (`scope.ts`), front-end
  (`frontend.ts`); the per-SyntaxKind handlers live under `src/handlers/` by concern (registry,
  realm boundary, hoisting, iteration, references, operators, literals, functions, calls,
  generators, statements, classes, patterns) — `src/handlers.ts` registers them all.
- `test/differential/` — the differential oracle: tsval output vs Node output on the same program.
- `vendor/ts-evaluator/` — the test corpus of [ts-evaluator](https://github.com/wessberg/ts-evaluator) (MIT),
  differential-oracle input; nothing of it is shipped or imported.

## License

MIT.
