# tsval — new-session kickoff

You're picking up a project in `~/Documents/GitHub/tsval`. Read, in order:
1. [`./ASSIGNMENT.md`](./ASSIGNMENT.md) — the full brief: mission, decisions, staged plan.
2. [`./SVAL-NOTES.md`](./SVAL-NOTES.md) — reference on sval internals.

These encode decisions already made — follow them, don't relitigate. This file is orientation + your
first task.

## What you are building (say it plainly)

**tsval: a STEPPED, STACK-BASED, TypeScript-AST INTERPRETER.** It walks the native TypeScript compiler
AST (`ts.SyntaxKind`, "Path B"), executes it on an **explicit continuation-stack VM** (not host
recursion), and supports **single-stepping, pause/resume, and snapshot/fork** of execution state.
**That interpreter IS the deliverable. Build it.**

## Why it exists (context, not your first task)

It's the dynamic half of a capability-analysis system. A static kernel in `../lib`
(`util/silo/callsites.ts` + `util/silo/detect.ts`) predicts which capabilities a file reaches and
against what resources. tsval's distinctive powers — stepping, snapshot/fork, and injectable
capability shims — will later power a **"canary"** that runs code and hard-aborts on any runtime
divergence from the static prediction (a construction static analysis missed). **That canary is a LATER
stage (ASSIGNMENT S5).** Do not build it first, and do not substitute it for the interpreter — it is
the reason the interpreter must be steppable/forkable, nothing more.

## Use ts-evaluator as REFERENCE + ORACLE, not as the thing you ship

wessberg's ts-evaluator (https://github.com/wessberg/ts-evaluator, MIT) is a **recursive, one-shot**
TS-AST interpreter — it **cannot step or fork**, which is exactly why you're building tsval. But it
already has Path B coverage, type-awareness, and a mature capability policy. Use it three ways:
- Its per-node `evaluate-*.ts` files are your **semantics spec** (what each `SyntaxKind` must do) — each
  maps to a continuation-frame handler in your VM.
- **Steal its tests** as a regression oracle; also TypeScript's `tests/cases/` and test262 (all
  permissive licenses). See ASSIGNMENT §5 S0 for the differential-oracle pattern.
- Lift its **policy/environment/moduleOverride design** when you reach the shim/canary stage.

You are writing your own steppable stack executor. **Do not build tsval "on top of" ts-evaluator.**

## Your first deliverable (ASSIGNMENT S0 + S1)

1. Scaffold the package here (`typescript` + a test runner).
2. Stand up the **differential test harness**: tsval-output vs Node-output on the tsc-emitted JS, so any
   program is an oracle (corpora plug in later).
3. Build the **skeleton VM**: value stack + control stack of `{node, phase, scope}` frames + a `step()`
   loop over `ts.createSourceFile` output, covering a core subset (literals, identifiers, binary ops,
   var/let/const, block scoping, if, call, function, return).

**Acceptance:** run `const u = "https://x"; const n = 1 + 2; id(u, n)` end to end AND single-step
through it (`step()`/`stepStatement()`), observing the value/control stacks between steps. Green on a
starter differential subset.

Then proceed through ASSIGNMENT's stages: **S2** coverage → **S3** stepping API + async/generators →
**S4** snapshot/fork → **S5** capability shims + canary → **S6** type-aware.

## Surroundings (verify each from source — don't trust summaries, including this one)

- `./ASSIGNMENT.md`, `./SVAL-NOTES.md` — the briefs.
- `../lib/util/silo/callsites.ts`, `detect.ts` — the static kernel (read for the predicted-set shape;
  needed at S5, not now).
- ts-evaluator (`git clone https://github.com/wessberg/ts-evaluator`) — reference + oracle.
- sval (https://github.com/Siubaak/sval), DumbLang
  (`~/Library/Mobile Documents/com~apple~CloudDocs/Code/DumbLang`) — reference only.

## Working style

- The interpreter is the deliverable; the canary is a later stage — **don't invert that.**
- Continuation-stack AST-walker, not a bytecode compiler (ASSIGNMENT §3), unless you hit a wall.
- Correctness first, driven by the differential oracle; grow coverage against it (throw on
  unimplemented `SyntaxKind`s, then close gaps).
- Fail loud on invariant violations; only permissive-license corpora, vendored with attribution.
- Verify library APIs from source before relying on them.
- Append decisions/progress to `PROGRESS.md` so the next session inherits it.

Get started: read the two briefs, then work through the First Deliverable.
